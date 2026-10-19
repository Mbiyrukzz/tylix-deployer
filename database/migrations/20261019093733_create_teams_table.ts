import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("teams", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("name");
        table.string("slug").unique();
        table.integer("owner_id");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("teams");
};