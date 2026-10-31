import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("activity_dismissals", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("team_id");
        table.string("event_id");
        table.integer("dismissed_by");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("activity_dismissals");
};