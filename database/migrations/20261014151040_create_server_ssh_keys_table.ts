import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("server_ssh_keys", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        table.integer("server_id");
        table.integer("ssh_key_id");
        table.string("ssh_user");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("server_ssh_keys");
};