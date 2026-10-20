import { Invoice, type InvoiceAttributes } from "../models/Invoice.js";

export type InvoiceStatus = "due" | "paid" | "failed";

export interface InvoiceInput {
    teamId: number;
    code: string;
    plan: string;
    amount: number;
    currency: string;
    status: InvoiceStatus;
    description: string;
    dueDate: string;
    paidAt: string;
    reference: string;
}

async function allInvoices(): Promise<InvoiceAttributes[]> {
    return (await Invoice.all()) as unknown as InvoiceAttributes[];
}

export function toPublicInvoice(i: InvoiceAttributes) {
    const major = (Number(i.amount) || 0) / 100;
    return {
        id: i.id,
        number: i.number,
        description: i.description,
        status: i.status,
        dateText: String(i.due_date || i.created_at || "").slice(0, 10),
        amountText: `${i.currency} ${major.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    };
}

export const InvoiceService = {
    async forTeam(teamId: number): Promise<InvoiceAttributes[]> {
        const rows = await allInvoices();
        return rows.filter((r) => Number(r.team_id) === teamId).sort((a, b) => b.id - a.id);
    },

    /** Safe to call twice for the same Paystack event. A paid invoice is never moved back. */
    async record(input: InvoiceInput) {
        const rows = await allInvoices();
        const existing = rows.find((r) => r.paystack_invoice_code === input.code);

        if (existing) {
            if (existing.status === "paid" && input.status !== "paid") return;
            await Invoice.update(existing.id, {
                status: input.status,
                amount: input.amount || existing.amount,
                paid_at: input.paidAt || existing.paid_at,
                due_date: input.dueDate || existing.due_date,
                paystack_reference: input.reference || existing.paystack_reference,
            });
            return;
        }

        const created = (await Invoice.create({
            team_id: input.teamId,
            number: "",
            description: input.description,
            plan: input.plan,
            amount: input.amount,
            currency: input.currency,
            status: input.status,
            due_date: input.dueDate,
            paid_at: input.paidAt,
            paystack_invoice_code: input.code,
            paystack_reference: input.reference,
        })) as unknown as InvoiceAttributes | null;

        if (created) {
            await Invoice.update(created.id, { number: `INV-${String(created.id).padStart(5, "0")}` });
        }
    },
};