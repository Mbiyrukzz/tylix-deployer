import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("posts", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("title");
        table.text("body");
        table.integer("user_id");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("posts");
};