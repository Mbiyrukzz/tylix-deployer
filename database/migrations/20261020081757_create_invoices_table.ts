import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("invoices", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("team_id");
        table.string("number");
        table.string("description");
        table.string("plan");
        // Smallest currency unit, as Paystack sends it (KES 1,345.50 is 134550).
        table.integer("amount");
        table.string("currency");
        // due | paid | failed
        table.string("status");
        table.string("due_date");
        table.string("paid_at");
        table.string("paystack_invoice_code");
        table.string("paystack_reference");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("invoices");
};