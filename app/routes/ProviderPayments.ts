/**
 * Provider payment routes: paying the cloud provider's own bill from the deployer.
 *
 * GET  /api/providers/:id/billing/payment-options    what this connection can do about payment
 * GET  /api/providers/:id/billing/payment-log        the last 20 payments started from here
 * POST /api/providers/:id/billing/payments           { amount, methodId, cvv?, code? }
 *
 * The existing /api/providers/:id/billing routes (balance, invoices, history) are
 * untouched; these add the "pay" side next to them.
 *
 * Same rules as the other provider routes:
 *   - the connection must be on the caller's team (404 otherwise)
 *   - reading is open to every member; paying needs the admin role
 *   - POST answers 402 while the team is view only (withBillingLock)
 *   - a token without the Account scope answers 403 with code "missing_access"
 *
 * Paying moves real money, so on top of that:
 *   - everything that can be checked without charging (amount, card, CVV shape) is
 *     checked first, so a request that was going to be refused never spends a code
 *   - two-factor: when the caller has it on, a valid code is needed (StepUpService),
 *     taken from the body or the query string (`code`)
 *   - one payment at a time per connection: a lock in this process, plus the audit
 *     rows in provider_payments, so a double click, a second worker or a restart
 *     can't charge twice
 *   - every attempt is written to provider_payments BEFORE the charge ("pending")
 *     and closed afterwards. No row, no charge. A row left "pending" means the
 *     process stopped mid-charge: check the provider's payment history.
 *   - the CVV is used for this one request: never stored, never logged, never echoed
 *
 * ASSUMPTION: request bodies aren't logged anywhere else (an access log, a debug
 * middleware). Check that before enabling card payments: a logged body would
 * contain the CVV.
 */

import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { Provider } from "../models/Provider.js";
import { ProviderPayment } from "../models/ProviderPayment.js";
import { providerName, providerSecret } from "../services/ProviderAdapter.js";
import { LinodeError } from "../services/LinodeClient.js";
import {
    billingFor,
    billingModeOf,
    billingConsoleUrl,
    MAX_PAYMENT_USD,
    BillingInputError,
    PaymentOutcomeUnknownError,
    type ProviderBilling,
    type PreparedPayment,
} from "../services/ProviderBilling.js";

import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";
import { StepUpService } from "../services/StepUpService.js";
type Handler = Parameters<Router["get"]>[1];

interface ProviderRow {
    id: number;
    user_id: number;
    team_id: number | null;
    kind: string;
    api_token: string;
    credentials: string;
}

interface PaymentRow {
    id: number;
    provider_id: number;
    amount_cents: number;
    currency: string;
    method_label: string;
    status: string;
    message: string;
    started_at: string;
    [key: string]: unknown;
}

const ACCESS_HELP =
    "This Linode token can't use billing. Create a personal access token with the Account scope (Read/Write to make payments) and paste it into the connection.";

/** Closes the gap between the "just started?" check and the audit row existing (same process). */
const inFlight = new Set<number>();

/** After a payment went through (or may have), no new one for this long. */
const COOLDOWN_MS = 15_000;

/** A "pending" row this young means a payment is being made right now. */
const PENDING_WINDOW_MS = 2 * 60 * 1000;

/** The second-factor code the client sent: body first, then query string. */
function codeOf(req: TylixRequest): unknown {
    const fromBody = (req.body as { code?: unknown } | undefined)?.code;
    if (fromBody !== undefined && fromBody !== null && String(fromBody).trim() !== "") return fromBody;
    return req.query?.code;
}

/** The caller's connection and team, only if it is on their team. Answers 404 itself and returns null otherwise. */
async function loadRow(
    req: TylixRequest,
    res: TylixResponse,
): Promise<{ row: ProviderRow; teamId: number } | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const row = (await Provider.find(req.params.id)) as ProviderRow | null;

    if (!row || (await teamIdOfRow(row)) !== teamId) {
        res.status(404);
        res.json({ error: "Provider connection not found." });
        return null;
    }

    return { row, teamId };
}

/** The billing capability for this connection, or null after answering. */
function buildBilling(res: TylixResponse, row: ProviderRow): ProviderBilling | null {
    const name = providerName(row.kind);

    try {
        const billing = billingFor(row.kind, providerSecret(row));
        if (billing) return billing;
    } catch (error) {
        console.error(`[provider-billing] couldn't build the ${row.kind} billing adapter:`, error);
        res.status(422);
        res.json({ error: `This ${name} connection can't be used. Edit it and paste the credentials again.` });
        return null;
    }

    res.status(422);
    res.json({
        error: `Payments can't be made from here for ${name}. Use its billing page.`,
        code: "unsupported",
        consoleUrl: billingConsoleUrl(row.kind),
    });
    return null;
}

/** Maps every failure to an answer. Never includes anything the client sent. */
function fail(res: TylixResponse, row: ProviderRow, error: unknown): void {
    const name = providerName(row.kind);

    if (error instanceof BillingInputError) {
        res.status(422);
        res.json({ error: error.message });
        return;
    }

    if (error instanceof PaymentOutcomeUnknownError) {
        res.status(502);
        res.json({ error: error.message, code: "outcome_unknown", consoleUrl: billingConsoleUrl(row.kind) });
        return;
    }

    if (error instanceof LinodeError) {
        if (error.status === 401 || error.status === 403) {
            res.status(403);
            res.json({ error: ACCESS_HELP, code: "missing_access" });
            return;
        }

        if (error.status === 429) {
            res.status(429);
            res.json({ error: `${name} is rate limiting requests. Wait a minute and try again.` });
            return;
        }

        // A declined card, a payment below the minimum, and so on: Linode's own message.
        if (error.status >= 400 && error.status < 500) {
            res.status(422);
            res.json({ error: error.message });
            return;
        }
    }

    console.error(`[provider-billing] ${row.kind} call failed:`, error instanceof Error ? error.message : error);
    res.status(502);
    res.json({ error: `Couldn't reach ${name}. Try again in a moment.` });
}

/** The text stored with a failed or unclear payment. Only messages we wrote or the provider wrote. */
function errorText(error: unknown): string {
    if (error instanceof LinodeError || error instanceof PaymentOutcomeUnknownError) {
        return error.message.slice(0, 500);
    }
    return "Unexpected error.";
}

// ADAPT: `all()` then filtering in code, the same way the packages route lists tasks.
// Replace with your where/limit query if your Model has one.
async function paymentsOf(providerId: number): Promise<PaymentRow[]> {
    const all = (await ProviderPayment.all()) as PaymentRow[];
    return all.filter((p) => Number(p.provider_id) === providerId);
}

/** True when a payment for this connection is being made, or just went through (or may have). */
async function recentlyActive(providerId: number): Promise<boolean> {
    const rows = await paymentsOf(providerId);

    return rows.some((p) => {
        const age = Date.now() - Date.parse(String(p.started_at));
        if (Number.isNaN(age)) return false;

        if (p.status === "pending") return age < PENDING_WINDOW_MS;
        if (p.status === "paid" || p.status === "unknown") return age < COOLDOWN_MS;
        return false;
    });
}

/** Writes the "pending" audit row. Returns its id, or null when it couldn't be written (then nothing is charged). */
async function openEntry(input: {
    userId: number;
    teamId: number;
    row: ProviderRow;
    prepared: PreparedPayment;
}): Promise<number | null> {
    try {
        const created = (await ProviderPayment.create({
            user_id: input.userId,
            team_id: input.teamId,
            provider_id: input.row.id,
            kind: input.row.kind,
            amount_cents: Math.round(input.prepared.amount * 100),
            currency: "USD",
            method_id: input.prepared.methodId,
            method_label: input.prepared.methodLabel,
            payment_ref: "",
            status: "pending",
            message: "",
            started_at: new Date().toISOString(),
        })) as { id: number } | null;

        return created ? Number(created.id) : null;
    } catch (error) {
        console.error("[provider-billing] couldn't write the audit row:", error instanceof Error ? error.message : error);
        return null;
    }
}

/** Closes the audit row. Returns false when it couldn't be updated (the row then stays "pending"). */
async function closeEntry(id: number, patch: Record<string, unknown>): Promise<boolean> {
    try {
        await ProviderPayment.update(id, patch);
        return true;
    } catch (error) {
        console.error("[provider-billing] couldn't update the audit row:", error instanceof Error ? error.message : error);
        return false;
    }
}

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    // Every POST, PUT, PATCH and DELETE below answers 402 while the team is view only.
    const auth = withBillingLock(baseAuth);

    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/providers/:id/billing/payment-options",
        auth(async (req, res) => {
            const loaded = await loadRow(req, res);
            if (!loaded) return;
            const { row } = loaded;

            const mode = billingModeOf(row.kind);
            const consoleUrl = billingConsoleUrl(row.kind);
            const provider = providerName(row.kind);

            // No payment API for this provider: the page shows a button to its billing page.
            if (mode !== "pay") {
                res.json({ mode, consoleUrl, provider });
                return;
            }

            const billing = buildBilling(res, row);
            if (!billing) return;

            try {
                const [summary, methods] = await Promise.all([billing.summary(), billing.methods()]);

                res.json({
                    mode,
                    consoleUrl,
                    provider,
                    currency: "USD",
                    maxPaymentUsd: MAX_PAYMENT_USD,
                    summary,
                    methods,
                });
            } catch (error) {
                fail(res, row, error);
            }
        }),
    );

    router.get(
        "/api/providers/:id/billing/payment-log",
        auth(async (req, res) => {
            const loaded = await loadRow(req, res);
            if (!loaded) return;

            const rows = await paymentsOf(loaded.row.id);
            rows.sort((a, b) => b.id - a.id);

            res.json(
                rows.slice(0, 20).map((p) => ({
                    id: p.id,
                    amount_cents: Number(p.amount_cents),
                    currency: p.currency,
                    method_label: p.method_label,
                    status: p.status,
                    message: p.message,
                    started_at: p.started_at,
                })),
            );
        }),
    );

    router.post(
        "/api/providers/:id/billing/payments",
        write(async (req, res) => {
            const loaded = await loadRow(req, res);
            if (!loaded) return;
            const { row, teamId } = loaded;

            const billing = buildBilling(res, row);
            if (!billing) return;

            const body = (req.body ?? {}) as { amount?: unknown; methodId?: unknown; cvv?: unknown };

            // 1. Everything that can be refused without charging.
            let prepared: PreparedPayment;
            try {
                prepared = await billing.prepare(body.amount, body.methodId, body.cvv);
            } catch (error) {
                fail(res, row, error);
                return;
            }

            // 2. One at a time in this process (no await between the check and the add).
            if (inFlight.has(row.id)) {
                res.status(409);
                res.json({ error: "A payment is already being made for this account. Wait for it to finish." });
                return;
            }
            inFlight.add(row.id);

            try {
                // 3. One at a time everywhere: the audit rows know about other workers and restarts.
                if (await recentlyActive(row.id)) {
                    res.status(409);
                    res.json({
                        error: "A payment was just submitted for this account. Wait a moment and check the payment history before paying again.",
                    });
                    return;
                }

                // 4. Second factor, if the caller has one on. Right before the charge.
                if (!(await StepUpService.require(req, res, codeOf(req), "make this payment"))) return;

                // 5. Record it BEFORE charging. No row, no charge.
                const entryId = await openEntry({
                    userId: Number((req as any).user?.userId ?? 0),
                    teamId,
                    row,
                    prepared,
                });

                if (!entryId) {
                    res.status(500);
                    res.json({ error: "Couldn't record the payment, so nothing was charged. Try again." });
                    return;
                }

                // 6. The charge. Never retried.
                try {
                    const receipt = await billing.charge(prepared);

                    const closed = await closeEntry(entryId, { status: "paid", payment_ref: String(receipt.id) });
                    if (!closed) {
                        console.error("[provider-billing] payment went through but its audit row is still pending", {
                            entry: entryId,
                            payment: receipt.id,
                        });
                    }

                    console.log("[provider-billing] payment ok", {
                        entry: entryId,
                        provider: row.id,
                        usd: receipt.amount,
                        payment: receipt.id,
                    });

                    res.status(201);
                    res.json({ payment: receipt, method: prepared.methodLabel });
                } catch (error) {
                    const unknown = error instanceof PaymentOutcomeUnknownError;

                    await closeEntry(entryId, { status: unknown ? "unknown" : "failed", message: errorText(error) });

                    console.error("[provider-billing] payment not completed", {
                        entry: entryId,
                        provider: row.id,
                        usd: prepared.amount,
                        outcome: unknown ? "unknown" : "failed",
                    });

                    fail(res, row, error);
                }
            } finally {
                inFlight.delete(row.id);
            }
        }),
    );
}