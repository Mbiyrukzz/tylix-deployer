import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("provider_payments", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        table.integer("team_id");
        table.integer("provider_id");
        table.string("kind");
        // Whole cents, so nothing is ever rounded: 1250 means USD 12.50.
        table.integer("amount_cents");
        table.string("currency");
        table.integer("method_id");
        // For example "Visa ••4417". Never a full card number, never a CVV.
        table.string("method_label");
        // The provider's own payment id, as text. Empty until the payment goes through.
        table.string("payment_ref");
        // pending, paid, failed or unknown (see ProviderPayments.ts).
        table.string("status");
        // Why it failed, up to 500 characters. Empty otherwise.
        table.text("message");
        // ISO time in UTC, as text, so the "just started?" check never depends on database time zones.
        table.string("started_at");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("provider_payments");
};