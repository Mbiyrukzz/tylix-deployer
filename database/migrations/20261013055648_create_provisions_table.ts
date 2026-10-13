import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("provisions", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("provider_id");
        table.string("name");
        table.string("region");
        table.string("plan");
        table.string("image");
        table.string("template");
        table.string("step");
        table.string("status");
        table.integer("instance_id");
        table.string("ip");
        table.text("error");
        table.text("ssh_key");
        table.integer("server_id");
        table.integer("user_id");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("provisions");
};