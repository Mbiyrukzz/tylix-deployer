import type { Schema, AlterTableBuilder } from "@tylix/shared";

// The GitHub / GitLab account behind a connection: its picture and display
// name, saved when the token is checked so the Source control page can show
// them without calling the provider on every visit.
export const up = async (schema: Schema) => {
    try {
        await schema.alterTable("sourceproviders", (table: AlterTableBuilder) => {
            table.string("avatar_url", 500);
            table.string("display_name");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column/i.test(message)) throw error;
    }
};

export const down = async (schema: Schema) => {
    await schema.alterTable("sourceproviders", (table: AlterTableBuilder) => {
        table.dropColumn("avatar_url");
        table.dropColumn("display_name");
    });
};
