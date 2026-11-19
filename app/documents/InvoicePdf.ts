/**
 * A team invoice as a PDF (@tylix/pdf).
 *
 *   GET /api/billing/invoices/:id/pdf   (app/routes/invoices.ts)
 *
 * The seller block comes from .env (INVOICE_* in .env.example) so the legal
 * name, address and tax number can change without a deploy. Amounts are
 * stored in the smallest currency unit, as Paystack sends them.
 */

import path from "node:path";
import { createPdf } from "@tylix/pdf";
import type { InvoiceAttributes } from "../models/Invoice.js";

export interface InvoiceParty {
    team: string;
    name: string;
    email: string;
}

const BRAND = "#f97316";
const INK = "#18181b";
const MUTED = "#71717a";
const LINE = "#e4e4e7";

const STATUS: Record<string, { label: string; color: string; background: string }> = {
    paid: { label: "PAID", color: "#15803d", background: "#dcfce7" },
    failed: { label: "PAYMENT FAILED", color: "#b91c1c", background: "#fee2e2" },
    due: { label: "DUE", color: "#b45309", background: "#fef3c7" },
};

export function seller() {
    return {
        name: process.env.INVOICE_COMPANY_NAME || "Tylix Deploy",
        address: (process.env.INVOICE_COMPANY_ADDRESS || "").split("|").map((l) => l.trim()).filter(Boolean),
        email: process.env.INVOICE_COMPANY_EMAIL || process.env.MAIL_FROM || "",
        taxId: process.env.INVOICE_TAX_ID || "",
    };
}

/** "2026-11-19" from whatever date string the row holds, or "". */
export function dateOnly(value: unknown): string {
    const t = new Date(String(value ?? "")).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

export function majorAmount(invoice: Pick<InvoiceAttributes, "amount">): number {
    return (Number(invoice.amount) || 0) / 100;
}

function planName(plan: string): string {
    return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Subscription";
}

export function invoicePdf(invoice: InvoiceAttributes, billedTo: InvoiceParty) {
    const from = seller();
    const status = STATUS[invoice.status] ?? STATUS.due;
    const currency = invoice.currency || "KES";
    const issued = dateOnly(invoice.created_at);
    const due = dateOnly(invoice.due_date);
    const paid = dateOnly(invoice.paid_at);
    const amount = majorAmount(invoice);
    const number = invoice.number || `INV-${String(invoice.id).padStart(5, "0")}`;

    const facts: [string, string][] = [
        ["Invoice", number],
        ["Issued", issued || "-"],
        [invoice.status === "paid" ? "Paid" : "Due", (invoice.status === "paid" ? paid : due) || "-"],
    ];
    if (invoice.paystack_reference) facts.push(["Reference", invoice.paystack_reference]);

    return createPdf({
        title: `Invoice ${number}`,
        author: from.name,
        subject: `${from.name} invoice ${number} for ${billedTo.team}`,
        size: "A4",
        margins: [48, 48],
        currency,
        locale: "en-KE",
        basePath: process.cwd(),
        defaultStyle: { size: 10, color: INK },
        footer: (page) => ({
            columns: [
                { text: `${from.name}${from.email ? " · " + from.email : ""}`, size: 8, color: MUTED },
                { text: `Page ${page.page} of ${page.pages}`, size: 8, color: MUTED, align: "right" },
            ],
            margin: [48, 0],
        }),
        watermark: invoice.status === "paid" ? undefined : { text: status.label, color: status.color, opacity: 0.06, size: 96 },
        content: [
            {
                columns: [
                    {
                        stack: [
                            { image: path.join("public", "logo-mark.png"), width: 40 },
                            { text: from.name, bold: true, size: 13, margin: [0, 8, 0, 2] },
                            ...from.address.map((line) => ({ text: line, color: MUTED, size: 9 })),
                            ...(from.taxId ? [{ text: `Tax ID ${from.taxId}`, color: MUTED, size: 9 }] : []),
                        ],
                    },
                    {
                        stack: [
                            { text: "INVOICE", bold: true, size: 24, color: INK, align: "right", characterSpacing: 2 },
                            { text: number, color: MUTED, align: "right", margin: [0, 2, 0, 10] },
                            {
                                columns: [
                                    { text: "" },
                                    {
                                        box: [{ text: status.label, bold: true, size: 9, color: status.color, align: "center" }],
                                        padding: [4, 10],
                                        background: status.background,
                                        radius: 10,
                                        width: 110,
                                    },
                                ],
                            },
                        ],
                    },
                ],
                gap: 24,
            },
            { hr: true, color: LINE, margin: [0, 20, 0, 0] },
            { spacer: 20 },
            {
                columns: [
                    {
                        stack: [
                            { text: "BILLED TO", bold: true, size: 8, color: MUTED, characterSpacing: 1, margin: [0, 0, 0, 6] },
                            { text: billedTo.team, bold: true, size: 11 },
                            ...(billedTo.name ? [{ text: billedTo.name }] : []),
                            ...(billedTo.email ? [{ text: billedTo.email, color: MUTED }] : []),
                        ],
                    },
                    {
                        table: {
                            columns: [
                                { key: "0", width: "*", value: (row: [string, string]) => ({ text: row[0], color: MUTED }) },
                                { key: "1", width: "auto", align: "right", value: (row: [string, string]) => ({ text: row[1], bold: true }) },
                            ],
                            rows: facts,
                            header: false,
                            borders: "none",
                        },
                    },
                ],
                gap: 32,
            },
            { spacer: 28 },
            {
                table: {
                    columns: [
                        { header: "Description", key: "description", width: "*" },
                        { header: "Plan", key: "plan", width: 90 },
                        { header: "Period", key: "period", width: 110 },
                        { header: "Amount", key: "amount", format: "currency", width: 100 },
                    ],
                    rows: [
                        {
                            description: invoice.description || `${from.name} ${planName(invoice.plan)} plan`,
                            plan: planName(invoice.plan),
                            period: [issued, due].filter(Boolean).join(" to ") || "-",
                            amount,
                        },
                    ],
                    borders: "horizontal",
                    headerStyle: { bold: true, size: 8, color: MUTED, background: "#fafafa" },
                    padding: [8, 10],
                },
            },
            {
                columns: [
                    { text: "" },
                    {
                        table: {
                            columns: [
                                { key: "label", width: "*", value: (r: { label: string; strong?: boolean }) => ({ text: r.label, color: r.strong ? INK : MUTED, bold: r.strong }) },
                                { key: "value", format: "currency", width: 100 },
                            ],
                            rows: [
                                { label: "Subtotal", value: amount },
                                { label: `Total (${currency})`, value: amount, strong: true },
                                ...(invoice.status === "paid" ? [{ label: "Amount paid", value: amount }, { label: "Balance due", value: 0, strong: true }] : [{ label: "Balance due", value: amount, strong: true }]),
                            ],
                            header: false,
                            borders: "none",
                            padding: [5, 10],
                        },
                        width: 240,
                    },
                ],
                margin: [0, 12, 0, 0],
            },
            { spacer: 36 },
            {
                box: [
                    { text: invoice.status === "paid" ? "Thank you, this invoice is paid." : "How to pay", bold: true, margin: [0, 0, 0, 4] },
                    {
                        text:
                            invoice.status === "paid"
                                ? `Paid${paid ? " on " + paid : ""} through Paystack${invoice.paystack_reference ? " (reference " + invoice.paystack_reference + ")" : ""}. Keep this invoice for your records.`
                                : "Pay from Settings → Billing in Tylix Deploy. Your servers and sites keep running while a payment is pending.",
                        color: MUTED,
                    },
                ],
                padding: 14,
                background: "#fff7ed",
                border: { color: "#fed7aa" },
                radius: 8,
            },
        ],
        styles: { brand: { color: BRAND } },
    } as Parameters<typeof createPdf>[0]);
}
