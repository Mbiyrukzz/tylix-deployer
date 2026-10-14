import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
await schema.createTable("backup_storages", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        table.string("name");
        table.string("provider");
        table.string("app_key");
        table.text("app_secret");
        table.text("refresh_token");
        table.timestamps();
});
};

export const down = async (schema: Schema) => {
await schema.dropTable("backup_storages");
};
