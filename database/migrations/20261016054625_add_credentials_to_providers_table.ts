import type { Schema, AlterTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.alterTable("providers", (table: AlterTableBuilder) => {
        table.text("credentials");
    });
};

export const down = async (schema: Schema) => {
    await schema.alterTable("providers", (table: AlterTableBuilder) => {
        table.dropColumn("credentials");
    });
};