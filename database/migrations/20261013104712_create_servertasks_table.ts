import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("servertasks", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("server_id");
        table.integer("user_id");
        table.string("packages");
        table.string("step");
        table.string("status");
        table.string("error");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("servertasks");
};