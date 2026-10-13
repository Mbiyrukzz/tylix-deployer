import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("servers", (table: CreateTableBuilder) => {
        table.increments("id");
        table.string("name");
        table.string("host");
        table.integer("port");
        table.string("ssh_user");
        table.text("ssh_key");
        table.string("status");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("servers");
};