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

        table.text("deploy_script");
        table.text("env_content");
        table.string("deploy_status");
        table.text("deploy_log");
        table.string("deployed_at");

        table.string("ssl_mode");
        table.string("ssl_status");
        table.string("ssl_email");
        table.text("ssl_error");
        table.text("ssl_log");
        table.string("ssl_expires_at");

        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("sites");
};