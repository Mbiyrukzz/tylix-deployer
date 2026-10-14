import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
await schema.createTable("server_backups", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        table.integer("server_id");
        table.string("name");
        table.text("databases");
        table.integer("storage_id");
        table.string("schedule");
        table.integer("retention");
        table.timestamps();
});
};

export const down = async (schema: Schema) => {
await schema.dropTable("server_backups");
};
