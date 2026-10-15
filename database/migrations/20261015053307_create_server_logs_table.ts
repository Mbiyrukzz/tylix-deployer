import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("server_logs", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        // server_id and provision_id are empty (null) for some rows: events from
        // before the server record exists have no server_id yet. If your builder
        // makes columns NOT NULL by default, mark these two nullable.
        table.integer("server_id");
        table.integer("provision_id");
        table.string("event");
        table.string("level");
        // text, not string: messages can be up to 500 characters.
        table.text("message");
        table.text("meta");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("server_logs");
};