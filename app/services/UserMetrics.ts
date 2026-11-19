/**
 * Counts this app's users for the Hub.
 *
 *   users_total   every registered account
 *   users_active  accounts that signed in during the last ACTIVE_DAYS days
 *
 * "Active" counts sign-ins and session use, not page visits. Tylix 2
 * sessions (auth_sessions) are deleted at logout, so a session's
 * last_used_at counts while it lives, and the 0.x refresh_tokens rows,
 * which were kept after logout, still count the sign-ins made before the
 * upgrade. Rows of deleted accounts are ignored.
 */

import { User } from "../models/User.js";
import { RefreshToken, type RefreshTokenAttributes } from "../models/RefreshToken.js";
import { AuthSession, type AuthSessionAttributes } from "../models/AuthSession.js";
import type { UserMetrics } from "./HubReporter.js";

const ACTIVE_DAYS = 30;

function toMs(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    return new Date(String(value ?? "")).getTime();
}

export async function collectUserMetrics(): Promise<UserMetrics> {
    const users = await User.all();
    const known = new Set<number>(users.map((u) => Number(u.id)));

    const tokens = (await RefreshToken.query().get()) as unknown as RefreshTokenAttributes[];
    const since = Date.now() - ACTIVE_DAYS * 24 * 60 * 60 * 1000;

    const active = new Set<number>();
    for (const token of tokens) {
        const userId = Number(token.user_id);
        if (!known.has(userId)) continue;

        const at = toMs(token.created_at);
        if (!Number.isNaN(at) && at >= since) active.add(userId);
    }

    const sessions = (await AuthSession.query().get()) as unknown as AuthSessionAttributes[];
    for (const session of sessions) {
        const userId = Number(session.user_id);
        if (!known.has(userId)) continue;

        const at = Math.max(toMs(session.last_used_at), toMs(session.created_at));
        if (!Number.isNaN(at) && at >= since) active.add(userId);
    }

    return { users_total: known.size, users_active: active.size, active_days: ACTIVE_DAYS };
}