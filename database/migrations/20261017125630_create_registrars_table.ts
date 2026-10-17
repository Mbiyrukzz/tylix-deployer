import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
await schema.createTable("registrars", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("kind");
        table.string("label");
        table.text("api_token");
        table.text("credentials");
        table.string("status");
        table.integer("user_id");
        table.timestamps();
});
};

export const down = async (schema: Schema) => {
await schema.dropTable("registrars");
};