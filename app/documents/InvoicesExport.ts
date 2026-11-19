/**
 * A team's invoices as an Excel workbook (@tylix/excel).
 *
 *   GET /api/billing/invoices/export.xlsx   (app/routes/invoices.ts)
 *
 * One sheet per currency would split totals awkwardly for the common case
 * (one currency), so it's one "Invoices" sheet with a currency column and a
 * per-currency summary sheet next to it.
 */

import { createWorkbook } from "@tylix/excel";
import type { InvoiceAttributes } from "../models/Invoice.js";
import { dateOnly, majorAmount, seller } from "./InvoicePdf.js";

const STATUS_LABEL: Record<string, string> = { paid: "Paid", due: "Due", failed: "Failed" };

function asDate(value: unknown): Date | null {
    const day = dateOnly(value);
    return day ? new Date(`${day}T00:00:00Z`) : null;
}

export function invoicesExport(invoices: InvoiceAttributes[], team: string) {
    const workbook = createWorkbook({ title: `${team} invoices`, creator: seller().name });

    const rows = invoices.map((i) => ({
        number: i.number || `INV-${String(i.id).padStart(5, "0")}`,
        issued: asDate(i.created_at),
        description: i.description,
        plan: i.plan ? i.plan.charAt(0).toUpperCase() + i.plan.slice(1) : "",
        currency: i.currency || "KES",
        amount: majorAmount(i),
        status: STATUS_LABEL[i.status] ?? i.status,
        due: asDate(i.due_date),
        paid: asDate(i.paid_at),
        reference: i.paystack_reference || "",
    }));

    const sheet = workbook.addSheet("Invoices", {
        columns: [
            { header: "Invoice", key: "number" },
            { header: "Issued", key: "issued", format: "date" },
            { header: "Description", key: "description", width: 40 },
            { header: "Plan", key: "plan" },
            { header: "Currency", key: "currency" },
            { header: "Amount", key: "amount", format: "#,##0.00", total: "sum" },
            { header: "Status", key: "status" },
            { header: "Due", key: "due", format: "date" },
            { header: "Paid", key: "paid", format: "date" },
            { header: "Reference", key: "reference", width: 24 },
        ],
        rows,
    });

    const last = rows.length + 1;
    if (rows.length > 0) {
        sheet.conditionalFormat(`G2:G${last}`, { type: "contains", text: "Paid", style: { color: "#15803d", fill: "#dcfce7" } });
        sheet.conditionalFormat(`G2:G${last}`, { type: "contains", text: "Failed", style: { color: "#b91c1c", fill: "#fee2e2" } });
        sheet.conditionalFormat(`G2:G${last}`, { type: "contains", text: "Due", style: { color: "#b45309", fill: "#fef3c7" } });
    }

    // Totals per currency: billed, paid and outstanding.
    const byCurrency = new Map<string, { currency: string; invoices: number; billed: number; paid: number; outstanding: number }>();
    for (const r of rows) {
        const t = byCurrency.get(r.currency) ?? { currency: r.currency, invoices: 0, billed: 0, paid: 0, outstanding: 0 };
        t.invoices += 1;
        t.billed += r.amount;
        if (r.status === "Paid") t.paid += r.amount;
        else t.outstanding += r.amount;
        byCurrency.set(r.currency, t);
    }

    workbook.addSheet("Summary", {
        columns: [
            { header: "Currency", key: "currency" },
            { header: "Invoices", key: "invoices", format: "integer" },
            { header: "Billed", key: "billed", format: "#,##0.00" },
            { header: "Paid", key: "paid", format: "#,##0.00" },
            { header: "Outstanding", key: "outstanding", format: "#,##0.00" },
        ],
        rows: [...byCurrency.values()],
    });

    return workbook;
}
