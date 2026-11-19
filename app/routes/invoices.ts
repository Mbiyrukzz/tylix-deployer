/**
 * Invoice downloads (the signed-in user's current team).
 *
 * GET /api/billing/invoices/:id/pdf        one invoice as a PDF       (invoices.download)
 * GET /api/billing/invoices/export.xlsx    every invoice, in Excel    (invoices.export)
 *
 * Both are owner-only, like the invoice list in billingPayments.ts: the
 * owner role is the one that holds invoices.* (app/permissions.ts).
 * ?inline=1 on the PDF opens it in the browser instead of downloading it.
 */

import type { Router } from "@tylix/core";
import { User } from "../models/User.js";
import { Invoice, type InvoiceAttributes } from "../models/Invoice.js";
import { TeamService } from "../services/TeamService.js";
import { InvoiceService } from "../services/InvoiceService.js";
import { requirePermission } from "../services/TeamScope.js";
import { invoicePdf } from "../documents/InvoicePdf.js";
import { invoicesExport } from "../documents/InvoicesExport.js";

type Handler = Parameters<Router["get"]>[1];

/** A file name that is safe in Content-Disposition on every OS. */
function fileSafe(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "team";
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/billing/invoices/export.xlsx",
        auth(async (req, res) => {
            if (!(await requirePermission(req, res, "invoices.export"))) return;

            const ctx = await TeamService.contextFor(Number(req.user!.userId));
            if (!ctx) return res.status(404).json({ error: "Account not found." });

            try {
                const rows = await InvoiceService.forTeam(ctx.team.id);
                const day = new Date().toISOString().slice(0, 10);
                res.setHeader("Cache-Control", "private, no-store");
                return res.download(invoicesExport(rows, ctx.team.name), `${fileSafe(ctx.team.name)}-invoices-${day}.xlsx`);
            } catch (error) {
                console.error("[billing] invoice export:", error);
                return res.status(500).json({ error: "Couldn't build the export. Try again." });
            }
        }),
    );

    router.get(
        "/api/billing/invoices/:id/pdf",
        auth(async (req, res) => {
            if (!(await requirePermission(req, res, "invoices.download"))) return;

            const [ctx, user] = await Promise.all([
                TeamService.contextFor(Number(req.user!.userId)),
                User.find(Number(req.user!.userId)),
            ]);
            if (!ctx || !user) return res.status(404).json({ error: "Account not found." });

            const id = Number(req.params.id);
            const invoice = Number.isInteger(id) && id > 0 ? ((await Invoice.find(id)) as unknown as InvoiceAttributes | null) : null;
            // Another team's invoice looks exactly like a missing one.
            if (!invoice || Number(invoice.team_id) !== Number(ctx.team.id)) {
                return res.status(404).json({ error: "Invoice not found." });
            }

            try {
                const pdf = invoicePdf(invoice, { team: ctx.team.name, name: user.name, email: user.email });
                const number = invoice.number || `INV-${String(invoice.id).padStart(5, "0")}`;
                res.setHeader("Cache-Control", "private, no-store");
                return res.download(pdf, `${fileSafe(number)}.pdf`, { inline: req.query.inline === "1" });
            } catch (error) {
                console.error("[billing] invoice pdf:", error);
                return res.status(500).json({ error: "Couldn't build the PDF. Try again." });
            }
        }),
    );
}
