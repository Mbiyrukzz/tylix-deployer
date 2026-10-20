import { Subscription, type SubscriptionAttributes } from "../models/Subscription.js";
import { getPlanDef, type PlanId } from "./Plans.js";
import { InvoiceService } from "./InvoiceService.js";

const PLAN_CODE_ENV: Record<PlanId, string> = {
    personal: "PAYSTACK_PLAN_PERSONAL",
    pro: "PAYSTACK_PLAN_PRO",
    business: "PAYSTACK_PLAN_BUSINESS",
};

export const planCodeFor = (plan: PlanId) => process.env[PLAN_CODE_ENV[plan]] || "";

export function planFromCode(code: string): PlanId | null {
    for (const id of Object.keys(PLAN_CODE_ENV) as PlanId[]) {
        if (planCodeFor(id) && planCodeFor(id) === code) return id;
    }
    return null;
}

const addMonth = () => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString();
};

const currencyOf = (d: any) => String(d?.currency || process.env.PAYSTACK_CURRENCY || "KES");

const isoOrEmpty = (v: unknown) => {
    const t = new Date(String(v ?? "")).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : "";
};

/** One row per team: the latest row, including a pending checkout. */
async function rowOf(teamId: number): Promise<SubscriptionAttributes | null> {
    const rows = ((await Subscription.all()) as SubscriptionAttributes[])
        .filter((r) => Number(r.team_id) === teamId)
        .sort((a, b) => b.id - a.id);
    return rows[0] ?? null;
}

async function byCode(code: string): Promise<SubscriptionAttributes | null> {
    if (!code) return null;
    const rows = (await Subscription.all()) as SubscriptionAttributes[];
    return rows.find((r) => r.paystack_subscription_code === code) ?? null;
}

async function byCustomer(customer: string): Promise<SubscriptionAttributes | null> {
    if (!customer) return null;
    const rows = ((await Subscription.all()) as SubscriptionAttributes[])
        .filter((r) => r.paystack_customer_code === customer)
        .sort((a, b) => b.id - a.id);
    return rows[0] ?? null;
}

async function save(teamId: number, patch: Record<string, unknown>) {
    const row = await rowOf(teamId);
    if (row) return Subscription.update(row.id, patch);

    return Subscription.create({
        team_id: teamId,
        plan: "",
        status: "pending",
        billing_interval: "monthly",
        paystack_customer_code: "",
        paystack_subscription_code: "",
        paystack_email_token: "",
        current_period_end: "",
        cancel_at_period_end: 0,
        ...patch,
    });
}

export const BillingService = {
    /** Saves a "pending" row so the webhook can find the team. Pending changes nothing in entitlements. */
    async markPending(teamId: number, plan: PlanId) {
        const row = await rowOf(teamId);

        if (row && row.status !== "pending" && row.paystack_subscription_code) return;
        if (row && row.status === "trialing") return;

        await save(teamId, { plan, status: "pending" });
    },

    /** A new team's trial. Called once, when the team is created. */
    async startTrial(teamId: number, days = 14) {
        if (await rowOf(teamId)) return;
        const end = new Date(Date.now() + days * 86_400_000).toISOString();
        await Subscription.create({
            team_id: teamId,
            plan: "pro",
            status: "trialing",
            billing_interval: "monthly",
            paystack_customer_code: "",
            paystack_subscription_code: "",
            paystack_email_token: "",
            current_period_end: end,
            cancel_at_period_end: 0,
        });
    },

    /** Only accounts created on or after BILLING_TRIALS_FROM get a trial. Earlier ones stay legacy (unlimited). */
    async startTrialFor(teamId: number, user: { created_at?: string | Date }, days = 14) {
        const from = process.env.BILLING_TRIALS_FROM;
        if (!from || !user.created_at) return;
        if (new Date(user.created_at).getTime() < new Date(from).getTime()) return;
        await this.startTrial(teamId, days);
    },

    /** Used by the callback page and by charge.success. Safe to run twice. */
    async activate(teamId: number, plan: PlanId, customerCode: string) {
        await save(teamId, {
            plan,
            status: "active",
            paystack_customer_code: customerCode,
            current_period_end: addMonth(),
            cancel_at_period_end: 0,
        });
    },

    /** Writes the invoice that an invoice.* event describes. */
    async recordInvoice(d: any, status: "due" | "paid" | "failed") {
        const sub = await byCode(String(d?.subscription?.subscription_code ?? d?.subscription_code ?? ""));
        if (!sub) return;

        const code = String(d?.invoice_code ?? d?.invoice?.invoice_code ?? d?.id ?? "");
        if (!code) return;

        const def = getPlanDef(sub.plan);

        await InvoiceService.record({
            teamId: Number(sub.team_id),
            code,
            plan: String(sub.plan),
            amount: Number(d?.amount ?? d?.subscription?.amount) || 0,
            currency: currencyOf(d),
            status,
            description: `${def?.name ?? "Plan"} plan, monthly`,
            dueDate: isoOrEmpty(d?.due_date ?? d?.subscription?.next_payment_date ?? d?.period_end ?? sub.current_period_end),
            paidAt: status === "paid" ? isoOrEmpty(d?.paid_at) || new Date().toISOString() : "",
            reference: String(d?.transaction?.reference ?? ""),
        });
    },

    /** Webhook events. Unknown events are ignored. */
    async handleEvent(event: { event: string; data: any }) {
        const d = event.data ?? {};

        if (process.env.BILLING_DEBUG === "1") {
            console.log("[billing] event:", event.event, JSON.stringify(d).slice(0, 1500));
        }

        switch (event.event) {
            case "charge.success": {
                const teamId = Number(d.metadata?.team_id);
                const plan = (d.metadata?.plan as PlanId) || planFromCode(d.plan?.plan_code ?? "");

                if (teamId && plan && getPlanDef(plan)) {
                    await this.activate(teamId, plan, d.customer?.customer_code ?? "");

                    // The first payment's invoice. Renewals are recorded from invoice.update instead.
                    await InvoiceService.record({
                        teamId,
                        code: `chg_${String(d.reference ?? d.id ?? "")}`,
                        plan,
                        amount: Number(d.amount) || 0,
                        currency: currencyOf(d),
                        status: "paid",
                        description: `${getPlanDef(plan)!.name} plan, first month`,
                        dueDate: isoOrEmpty(d.paid_at) || new Date().toISOString(),
                        paidAt: isoOrEmpty(d.paid_at) || new Date().toISOString(),
                        reference: String(d.reference ?? ""),
                    });
                } else if (d.customer?.customer_code) {
                    // A renewal charge carries no metadata: find the team by customer.
                    const row = await byCustomer(d.customer.customer_code);
                    if (row) await save(Number(row.team_id), { status: "active", current_period_end: addMonth() });
                }
                return;
            }

            case "subscription.create": {
                const row = await byCustomer(d.customer?.customer_code ?? "");
                if (!row) return;
                await Subscription.update(row.id, {
                    plan: planFromCode(d.plan?.plan_code ?? "") ?? row.plan,
                    status: "active",
                    paystack_subscription_code: d.subscription_code,
                    paystack_email_token: d.email_token,
                    current_period_end: d.next_payment_date ? new Date(d.next_payment_date).toISOString() : row.current_period_end,
                });
                return;
            }

            case "invoice.create": {
                await this.recordInvoice(d, "due");
                return;
            }

            case "invoice.update": {
                const row = await byCode(d.subscription?.subscription_code ?? "");
                if (!row) return;
                if (d.paid) {
                    await Subscription.update(row.id, {
                        status: "active",
                        current_period_end: d.subscription?.next_payment_date
                            ? new Date(d.subscription.next_payment_date).toISOString()
                            : row.current_period_end,
                    });
                    await this.recordInvoice(d, "paid");
                }
                return;
            }

            case "invoice.payment_failed": {
                const row = await byCode(d.subscription?.subscription_code ?? "");
                if (row) await Subscription.update(row.id, { status: "past_due" });
                await this.recordInvoice(d, "failed");
                return;
            }

            case "subscription.not_renew": {
                const row = await byCode(d.subscription_code ?? "");
                if (row) await Subscription.update(row.id, { cancel_at_period_end: 1 });
                return;
            }

            case "subscription.disable": {
                const row = await byCode(d.subscription_code ?? "");
                // The period end stays, so access continues until the paid time runs out.
                if (row) await Subscription.update(row.id, { status: "canceled" });
                return;
            }
        }
    },

    rowOf,
};