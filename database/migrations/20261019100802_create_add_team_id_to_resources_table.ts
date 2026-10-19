import type { Schema, AlterTableBuilder } from "@tylix/shared";

const TABLES = [
    // Remove the two slashes from these three lines ONLY if you did NOT
    // already run the earlier team_id migration for them.
    // "providers",
    // "servers",
    // "provisions",

    "backup_storages",
    "db_users",
    "deployments",
    "registrars",
    "server_backups",
    "server_cron_jobs",
    "server_databases",
    "server_firewall_rules",
    "server_logs",
    "server_ssh_keys",
    "servertasks",
    "server_workers",
    "site_plugins",
    "sites",
    "sourceproviders",
    "ssh_keys",
];

export const up = async (schema: Schema) => {
    for (const name of TABLES) {
        await schema.alterTable(name, (table: AlterTableBuilder) => {
            table.integer("team_id");
        });
    }
};

export const down = async (schema: Schema) => {
    for (const name of TABLES) {
        await schema.alterTable(name, (table: AlterTableBuilder) => {
            table.dropColumn("team_id");
        });
    }
};