import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("team_invitations", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("team_id");
        table.string("email");
        table.string("role");
        table.string("token_hash");
        table.integer("invited_by");
        // ISO strings; accepted_at is "" until the invite is used.
        table.string("expires_at");
        table.string("accepted_at");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("team_invitations");
};