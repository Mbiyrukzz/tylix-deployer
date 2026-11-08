import type { Schema, AlterTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.alterTable("deployments", (table: AlterTableBuilder) => {
        table.string("commit_sha");
        table.text("commit_message");
    });
};

export const down = async (schema: Schema) => {
    await schema.alterTable("deployments", (table: AlterTableBuilder) => {
        table.dropColumn("commit_sha");
        table.dropColumn("commit_message");
    });
};