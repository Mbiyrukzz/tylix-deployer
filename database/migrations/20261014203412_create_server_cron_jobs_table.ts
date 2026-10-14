import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
await schema.createTable("server_cron_jobs", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        table.integer("server_id");
        table.string("name");
        table.text("command");
        table.string("ssh_user");
        table.string("schedule");
        table.timestamps();
});
};

export const down = async (schema: Schema) => {
await schema.dropTable("server_cron_jobs");
};