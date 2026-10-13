import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("providers", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("kind");
        table.string("label");
        table.text("api_token");
        table.string("status");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("providers");
};