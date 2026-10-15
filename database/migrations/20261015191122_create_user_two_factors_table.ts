/**
 * Table: user_two_factors
 *
 * One row per user who has started setting up two-factor auth.
 *   - secret          TOTP secret, encrypted with CryptoService
 *   - confirmed_at    null until the user proves the app works; only then is 2FA "on"
 *   - recovery_codes  JSON array of SHA-256 hashes (the plain codes are shown once)
 *   - last_step       last TOTP time-step accepted, so a code can't be replayed
 *
 * A separate table (instead of new columns on users) keeps the generated
 * User model and its migration untouched.
 */

import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("user_two_factors", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id").unique();
        table.text("secret");
        table.datetime("confirmed_at");
        table.text("recovery_codes");
        table.integer("last_step");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("user_two_factors");
};