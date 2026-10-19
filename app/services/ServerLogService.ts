/**
 * Service: ServerLogService
 *
 * One place that writes and reads server events.
 *
 *   - record() NEVER throws. A failed log write must not break a reboot,
 *     a delete or a provision.
 *   - meta is sanitised: any key that looks like a credential is redacted,
 *     private key material is scrubbed from strings, long strings are cut.
 *   - Events can belong to a provision before the server record exists
 *     (provision_id set, server_id null). attachProvision() links them
 *     once the server is added to the list.
 *   - Every event carries team_id, so a whole team can see a server's
 *     history. Callers don't have to pass it: record() reads it from the
 *     server (or provision) the event is about. userId is the person who
 *     acted.
 */

import { ServerLog } from "../models/ServerLog.js";
import { Server } from "../models/Server.js";
import { Provision } from "../models/Provision.js";

export type LogLevel = "info" | "success" | "warning" | "error";

export interface LogInput {
    /** The person who acted. */
    userId: number;
    /** Optional. When omitted it is read from the server or provision. */
    teamId?: number | null;
    serverId?: number | null;
    provisionId?: number | null;
    /** Dotted name, e.g. "server.created", "server.reboot.failed". */
    event: string;
    message: string;
    level?: LogLevel;
    meta?: Record<string, unknown>;
}

export interface ServerLogRow {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number | null;
    provision_id: number | null;
    event: string;
    level: string;
    message: string;
    meta: string;
    created_at: string;
    [key: string]: unknown;
}

const LEVELS: LogLevel[] = ["info", "success", "warning", "error"];
/** Named groups of events for the Logs filter. Only these names are accepted. */
const CATEGORIES: Record<string, string[]> = {
    firewall: ["firewall.", "provision.firewall."],
};
const SENSITIVE_KEY = /key|password|passphrase|token|secret|credential/i;
const MAX_STRING = 300;
const MAX_DEPTH = 3;

function scrub(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return value;

    if (typeof value === "string") {
        if (/PRIVATE KEY-----/.test(value)) return "[redacted]";
        return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value;
    }

    if (typeof value === "number" || typeof value === "boolean") return value;

    if (depth >= MAX_DEPTH) return "[truncated]";

    if (Array.isArray(value)) {
        return value.slice(0, 50).map((v) => scrub(v, depth + 1));
    }

    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
        }
        return out;
    }

    return String(value);
}

function parseMeta(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "string" || raw === "") return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** The team an event belongs to: given, else the server's, else the provision's. */
async function resolveTeamId(input: LogInput): Promise<number | null> {
    const given = Number(input.teamId);
    if (Number.isInteger(given) && given > 0) return given;

    try {
        if (input.serverId) {
            const server = (await Server.find(input.serverId)) as { team_id?: number | null } | null;
            if (server?.team_id) return Number(server.team_id);
        }
        if (input.provisionId) {
            const provision = (await Provision.find(input.provisionId)) as { team_id?: number | null } | null;
            if (provision?.team_id) return Number(provision.team_id);
        }
    } catch {
        // Logging must never fail the caller; the event is stored without a team.
    }

    return null;
}

export const ServerLogService = {
    async record(input: LogInput): Promise<void> {
        try {
            await ServerLog.create({
                user_id: input.userId,
                team_id: await resolveTeamId(input),
                server_id: input.serverId ?? null,
                provision_id: input.provisionId ?? null,
                event: input.event.slice(0, 64),
                level: input.level ?? "info",
                message: String(scrub(input.message)).slice(0, 500),
                meta: JSON.stringify(scrub(input.meta ?? {})),
            });
        } catch (error) {
            console.error(`[server-log] could not record ${input.event}:`, error);
        }
    },

    /** Links every event of a provision to the server record it produced. */
    async attachProvision(provisionId: number, serverId: number): Promise<void> {
        try {
            const server = (await Server.find(serverId)) as { team_id?: number | null } | null;
            const teamId = server?.team_id ? Number(server.team_id) : 0;

            const rows = (await ServerLog.all()) as ServerLogRow[];
            for (const row of rows) {
                if (Number(row.provision_id) === provisionId && !row.server_id) {
                    await ServerLog.update(row.id, {
                        server_id: serverId,
                        ...(teamId && !row.team_id ? { team_id: teamId } : {}),
                    });
                }
            }
        } catch (error) {
            console.error(`[server-log] could not attach provision ${provisionId}:`, error);
        }
    },

    /**
     * Newest first. All events for this server, whoever on the team caused
     * them. The caller must already have checked that the server belongs to
     * the caller's team (userId is kept only so existing callers still compile).
     */
    async list(
        serverId: number,
        _userId: number,
        options: { level?: string; category?: string; limit?: number } = {},
    ) {
        const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
        const level = LEVELS.includes(options.level as LogLevel) ? options.level : "";
        const prefixes = options.category ? CATEGORIES[options.category] : undefined;

        const rows = (await ServerLog.all()) as ServerLogRow[];

        return rows
            .filter(
                (r) =>
                    Number(r.server_id) === serverId &&
                    (!level || r.level === level) &&
                    (!prefixes || prefixes.some((p) => String(r.event).startsWith(p))),
            )
            .sort((a, b) => {
                const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                return diff !== 0 ? diff : b.id - a.id;
            })
            .slice(0, limit)
            .map((r) => ({
                id: r.id,
                event: r.event,
                level: r.level,
                message: r.message,
                meta: parseMeta(r.meta),
                created_at: r.created_at,
            }));
    },

    /** Used when a server is deleted, so no log row points at a server that is gone. */
    async deleteForServer(serverId: number): Promise<void> {
        const rows = (await ServerLog.all()) as ServerLogRow[];
        for (const row of rows) {
            if (Number(row.server_id) === serverId) await ServerLog.delete(row.id);
        }
    },
};