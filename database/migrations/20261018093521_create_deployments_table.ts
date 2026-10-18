import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("deployments", (table: CreateTableBuilder) => {
        table.increments("id");

        table.integer("site_id");
        table.integer("user_id");

        table.string("status");
        table.text("log");
        table.string("branch");

        table.string("started_at");
        table.string("finished_at");

        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("deployments");
};