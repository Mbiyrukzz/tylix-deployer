import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("subscriptions", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("team_id");
        // personal | pro | business
        table.string("plan");
        // pending | trialing | active | past_due | canceled
        table.string("status");
        // monthly | yearly
        table.string("billing_interval");
        table.string("paystack_customer_code");
        table.string("paystack_subscription_code");
        table.string("paystack_email_token");
        // ISO string. For a trial this is the trial end.
        table.string("current_period_end");
        // 0 or 1
        table.integer("cancel_at_period_end");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("subscriptions");
};