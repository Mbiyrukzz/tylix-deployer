import type { Schema, CreateTableBuilder } from "@tylix/shared";

// Audit trail for Flux admins signing in as a customer (Admin → Users).
// One row per impersonation: who, as whom, why, from where, and when it
// ended. Rows are never deleted by the app.
export const up = async (schema: Schema) => {
    await schema.createTable("admin_impersonations", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("admin_user_id").index();
        table.integer("target_user_id").index();
        // The reason the admin typed (a ticket, an incident, a CVE...).
        table.string("reason", 500);
        // The auth_sessions.sid of the impersonation session, so logout and
        // expiry can close this row.
        table.string("session_sid", 32).index();
        table.string("ip", 64).nullable();
        table.string("user_agent", 512).nullable();
        table.string("started_at");
        // The session stops working after this, whatever happens.
        table.string("expires_at");
        table.string("ended_at").nullable();
        // "stopped" (Return to admin), "signed_out", "expired" or "revoked".
        table.string("end_reason", 32).nullable();
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("admin_impersonations");
};
