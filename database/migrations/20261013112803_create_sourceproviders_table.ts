import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("sourceproviders", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("kind");
        table.string("label");
        table.string("username");
        table.string("token");
        table.string("status");
        table.integer("user_id");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("sourceproviders");
};