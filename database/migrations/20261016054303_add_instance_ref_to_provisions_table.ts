import type { Schema, AlterTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.alterTable("provisions", (table: AlterTableBuilder) => {
        table.string("instance_ref");
    });
};

export const down = async (schema: Schema) => {
    await schema.alterTable("provisions", (table: AlterTableBuilder) => {
        table.dropColumn("instance_ref");
    });
};