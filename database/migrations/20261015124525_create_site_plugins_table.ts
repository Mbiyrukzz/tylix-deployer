import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("site_plugins", (table: CreateTableBuilder) => {
        table.increments("id");

        table.integer("user_id");
        table.integer("site_id");
        table.integer("server_id");

        table.string("plugin");
        table.string("status");
        table.string("step");
        table.text("error");
        table.text("log");
        table.text("config");
        table.string("installed_at");

        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("site_plugins");
};