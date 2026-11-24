import { Model } from "@tylix/orm";

/** One Flux admin "sign in as" session. See database/migrations/20261124090000_create_admin_impersonations_table.ts. */
export interface AdminImpersonationAttributes {
    id: number;
    admin_user_id: number;
    target_user_id: number;
    reason: string;
    session_sid: string;
    ip: string | null;
    user_agent: string | null;
    started_at: string;
    expires_at: string;
    ended_at: string | null;
    end_reason: string | null;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

/**
 * A stored time as an ISO string (UTC), or null. The ORM hands times back
 * as "YYYY-MM-DD HH:MM:SS" (UTC, see tylix.config.ts), which browsers would
 * read as local time and which doesn't compare with ISO strings.
 */
export function isoTime(value: unknown): string | null {
    if (value == null || value === "") return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    const text = String(value).trim();
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? "" : "Z") : text;
    const ms = Date.parse(normalized);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export class AdminImpersonation extends Model {
    static table = "admin_impersonations";

    static fillable: string[] = [
        "admin_user_id",
        "target_user_id",
        "reason",
        "session_sid",
        "ip",
        "user_agent",
        "started_at",
        "expires_at",
        "ended_at",
        "end_reason",
    ];

    static async find(id: number | string): Promise<AdminImpersonationAttributes | null> {
        return (await super.find(id)) as AdminImpersonationAttributes | null;
    }

    static async bySession(sid: string): Promise<AdminImpersonationAttributes | null> {
        if (!sid) return null;
        return (await this.query().where("session_sid", sid).first()) as AdminImpersonationAttributes | null;
    }

    static async recent(limit = 25): Promise<AdminImpersonationAttributes[]> {
        return (await this.query().orderBy("id", "DESC").limit(limit).get()) as AdminImpersonationAttributes[];
    }

    /** Closes the row once. Later calls (logout after expiry, say) keep the first reason. */
    static async end(sid: string, reason: "stopped" | "signed_out" | "expired" | "revoked"): Promise<void> {
        const row = await this.bySession(sid);
        if (!row || row.ended_at) return;
        await this.update(row.id, { ended_at: new Date().toISOString(), end_reason: reason });
    }
}
