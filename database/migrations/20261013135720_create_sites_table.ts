import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("sites", (table: CreateTableBuilder) => {
        table.increments("id");

        table.integer("user_id");
        table.integer("server_id");
        table.integer("source_control_id");

        table.string("type");
        table.string("domain");
        table.text("aliases");

        table.string("isolated_user");
        table.string("php_version");
        table.integer("port");

        table.string("repository");
        table.string("branch");
        table.string("web_directory");
        table.string("app_directory");
        table.string("backend_directory");
        table.string("build_command");
        table.string("start_command");
        table.integer("install_deps");

        table.string("status");
        table.string("step");
        table.text("error");
        table.text("log");

        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("sites");
};