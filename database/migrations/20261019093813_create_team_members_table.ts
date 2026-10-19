import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("team_members", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("team_id");
        table.integer("user_id");
        table.string("role");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("team_members");
};