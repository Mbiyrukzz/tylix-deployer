import type { Schema, CreateTableBuilder } from "@tylix/shared";

// Table names avoid "databases" on purpose: DATABASES is a reserved word in MySQL.

export const up = async (schema: Schema) => {
    // MySQL users created on a server. The password is stored encrypted.
    await schema.createTable("db_users", (table: CreateTableBuilder) => {
        table.increments("id");

        table.integer("user_id");
        table.integer("server_id");

        table.string("name");
        table.string("host");
        table.text("password");

        table.timestamps();
    });

    // Databases created on a server, each linked to one db_user (its owner).
    await schema.createTable("server_databases", (table: CreateTableBuilder) => {
        table.increments("id");

        table.integer("user_id");
        table.integer("server_id");
        table.integer("db_user_id");

        table.string("name");
        table.string("charset");
        table.string("collation");

        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("server_databases");
    await schema.dropTable("db_users");
};