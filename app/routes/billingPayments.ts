import type { Router } from "@tylix/core";
import { randomBytes } from "node:crypto";
import { User } from "../models/User.js";
import { TeamService } from "../services/TeamService.js";
import { PaystackService } from "../services/PaystackService.js";
import { BillingService, planCodeFor } from "../services/BillingService.js";
import { getPlanDef, type PlanId } from "../services/Plans.js";
import { InvoiceService, toPublicInvoice } from "../services/InvoiceService.js";

type Handler = Parameters<Router["get"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    async function ownerContext(req: any, res: any) {
        const user = await User.find(req.user!.userId as number);
        if (!user) {
            res.status(404).json({ error: "Account not found." });
            return null;
        }
        const ctx = await TeamService.ensureTeam(user);
        if (!TeamService.can(ctx.role, "owner")) {
            res.status(403).json({ error: "Only the team owner can manage billing." });
            return null;
        }
        return { user, ...ctx };
    }

    // Start a checkout: returns the Paystack page to send the browser to.
    router.post("/api/billing/checkout", auth((async (req: any, res: any) => {
        try {
            const c = await ownerContext(req, res);
            if (!c) return;

            const plan = String(req.body?.plan ?? "") as PlanId;
            if (!getPlanDef(plan)) return res.status(422).json({ error: "Choose a plan." });

            const code = planCodeFor(plan);
            if (!code) return res.status(500).json({ error: "This plan isn't set up on Paystack yet." });

            // A failed renewal isn't retried, so paying again starts a new subscription. End the old one first.
            const current = await BillingService.rowOf(c.team.id);
            if (current?.status === "past_due" && current.paystack_subscription_code && current.paystack_email_token) {
                try {
                    await PaystackService.disable(current.paystack_subscription_code, current.paystack_email_token);
                } catch (error) {
                    console.error("[billing] couldn't end the old subscription:", error);
                }
            }

            await BillingService.markPending(c.team.id, plan);

            const reference = `tdp_${c.team.id}_${randomBytes(8).toString("hex")}`;
            const init = await PaystackService.initialize({
                email: c.user.email,
                plan: code,
                reference,
                callbackUrl: `${process.env.APP_URL}/settings/billing`,
                metadata: { team_id: c.team.id, plan },
            });

            return res.json({ url: init.authorization_url });
        } catch (error) {
            console.error("[billing] checkout:", error);
            return res.status(502).json({ error: "Couldn't start the payment. Try again in a moment." });
        }
    }) as Handler));

    // The page calls this after Paystack sends the person back with ?reference=
    router.get("/api/billing/verify", auth((async (req: any, res: any) => {
        try {
            const c = await ownerContext(req, res);
            if (!c) return;

            const reference = String((req.query ?? {}).reference ?? "");
            const tx = await PaystackService.verify(reference);

            // The reference must belong to this team, or someone could activate a plan with another team's payment.
            if (tx.status !== "success" || Number(tx.metadata?.team_id) !== c.team.id) {
                return res.status(422).json({ error: "That payment wasn't completed." });
            }

            await BillingService.activate(c.team.id, tx.metadata!.plan as PlanId, tx.customer.customer_code);
            return res.json({ ok: true });
        } catch (error) {
            console.error("[billing] verify:", error);
            return res.status(502).json({ error: "Couldn't confirm the payment yet. It will update shortly." });
        }
    }) as Handler));

    // Stops renewal. Access continues until the period already paid for ends.
    router.post("/api/billing/cancel", auth((async (req: any, res: any) => {
        try {
            const c = await ownerContext(req, res);
            if (!c) return;

            const row = await BillingService.rowOf(c.team.id);
            if (!row?.paystack_subscription_code || !row.paystack_email_token) {
                return res.status(409).json({ error: "There is no paid subscription to cancel." });
            }

            await PaystackService.disable(row.paystack_subscription_code, row.paystack_email_token);
            return res.json({ ok: true });
        } catch (error) {
            console.error("[billing] cancel:", error);
            return res.status(502).json({ error: "Paystack didn't cancel the subscription. Try again." });
        }
    }) as Handler));

        // The team's invoices, newest first. Owner only, like the rest of billing.
    router.get("/api/billing/invoices", auth((async (req: any, res: any) => {
        try {
            const c = await ownerContext(req, res);
            if (!c) return;

            const rows = await InvoiceService.forTeam(c.team.id);
            return res.json(rows.map(toPublicInvoice));
        } catch (error) {
            console.error("[billing] invoices:", error);
            return res.status(500).json({ error: "Couldn't load invoices." });
        }
    }) as Handler));

       // Paystack calls this. No auth: the signature is the proof.
    router.post("/api/webhooks/paystack", (async (req: any, res: any) => {
        const raw: string = req.rawBody ? String(req.rawBody) : "";
        const signature = String(req.headers?.["x-paystack-signature"] ?? "");

        if (!PaystackService.validSignature(raw, signature)) {
            return res.status(401).json({ error: "Bad signature." });
        }

        try {
            await BillingService.handleEvent(req.body);
        } catch (error) {
            console.error("[billing] webhook:", error);
            // 500 makes Paystack retry later.
            return res.status(500).json({ error: "Failed." });
        }
        return res.status(200).json({ received: true });
    }) as Handler);
}