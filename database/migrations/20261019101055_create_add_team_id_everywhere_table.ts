import type { Schema, AlterTableBuilder } from "@tylix/shared";

const TABLES = [
    "providers",
    "servers",
    "provisions",
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
        try {
            await schema.alterTable(name, (table: AlterTableBuilder) => {
                table.integer("team_id");
            });
        } catch (error) {
            // Already has the column from the earlier migration: skip it.
            const message = error instanceof Error ? error.message : String(error);
            if (!/duplicate column/i.test(message)) throw error;
        }
    }
};

// Nothing to undo here: the earlier migration owns most of these columns.
export const down = async (_schema: Schema) => {};