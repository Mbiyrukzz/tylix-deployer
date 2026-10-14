import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("ssh_keys", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        table.string("name");
        table.text("public_key");
        table.string("fingerprint");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("ssh_keys");
};