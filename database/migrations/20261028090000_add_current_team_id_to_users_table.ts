import type { Schema, AlterTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    try {
        await schema.alterTable("users", (table: AlterTableBuilder) => {
            table.integer("current_team_id");
        });
    } catch (error) {
        // Column already exists (for example added by hand): skip it.
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column/i.test(message)) throw error;
    }
};

export const down = async (schema: Schema) => {
    await schema.alterTable("users", (table: AlterTableBuilder) => {
        table.dropColumn("current_team_id");
    });
};
