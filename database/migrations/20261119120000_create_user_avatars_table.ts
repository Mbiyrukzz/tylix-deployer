import type { Schema, CreateTableBuilder, AlterTableBuilder } from "@tylix/shared";

// Profile pictures (Settings -> Account). The image itself lives in its own
// table so the users row, which is read on every request, stays small.
// users.avatar_hash is the short content hash that goes in the picture's
// URL (/api/avatars/<user id>/<hash>): a new upload gets a new URL, so the
// browser can cache each one forever.
export const up = async (schema: Schema) => {
    await schema.createTable("user_avatars", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id").unique();
        table.string("mime");
        table.string("hash");
        // Base64 of a 256x256 image resized in the browser (tens of KB).
        table.mediumText("data");
        table.timestamps();
    });

    try {
        await schema.alterTable("users", (table: AlterTableBuilder) => {
            table.string("avatar_hash");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column/i.test(message)) throw error;
    }
};

export const down = async (schema: Schema) => {
    await schema.alterTable("users", (table: AlterTableBuilder) => {
        table.dropColumn("avatar_hash");
    });
    await schema.dropTable("user_avatars");
};
