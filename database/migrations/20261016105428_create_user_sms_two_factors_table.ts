import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
await schema.createTable("user_sms_two_factors", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        table.string("phone");
        table.string("confirmed_at");
        table.string("code_hash");
        table.string("code_expires_at");
        table.integer("code_attempts");
        table.string("last_sent_at");
        table.string("send_window_started_at");
        table.integer("send_count");
        table.timestamps();
});
};

export const down = async (schema: Schema) => {
await schema.dropTable("user_sms_two_factors");
};