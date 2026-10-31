/**
 * Service: TeamActivityService
 *
 * Builds a team activity feed from the rows members created. There is no
 * activity_logs table yet, so "activity" here means things a member added
 * to the team (servers, sites, deployments, connections and so on), dated by
 * created_at. Edits, deletes and sign-ins are not captured; for those you
 * need a real audit log written at the point of each action.
 *
 * ServerLog and ServerTask are left out on purpose: they are system noise,
 * not something a person did.
 *
 * Each source is read inside its own try/catch so one broken table can't
 * take the whole page down.
 */

import { BackupStorage } from "../models/BackupStorage.js";
import { DbUser } from "../models/DbUser.js";
import { Deployment } from "../models/Deployment.js";
import { Provider } from "../models/Provider.js";
import { Provision } from "../models/Provision.js";
import { Registrar } from "../models/Registrar.js";
import { Server } from "../models/Server.js";
import { ServerBackup } from "../models/ServerBackup.js";
import { ServerCronJob } from "../models/ServerCronJob.js";
import { ServerDatabase } from "../models/ServerDatabase.js";
import { ServerFirewallRule } from "../models/ServerFirewallRule.js";
import { ServerSshKey } from "../models/ServerSshKey.js";
import { ServerWorker } from "../models/ServerWorker.js";
import { Site } from "../models/Site.js";
import { SitePlugin } from "../models/SitePlugin.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { SshKey } from "../models/SshKey.js";

interface ActivityModel {
    query(): { where(column: string, value: unknown): { get(): Promise<unknown> } };
}

interface ActivityRow {
    id: number;
    user_id?: unknown;
    team_id?: unknown;
    created_at?: unknown;
    [key: string]: unknown;
}

interface ActivitySource {
    model: ActivityModel;
    kind: string;
    plural: string;
    verb: string;
}

export interface ActivityEvent {
    id: string;
    user_id: number;
    kind: string;
    verb: string;
    label: string;
    at: string;
}

export interface ActivitySummary {
    total: number;
    last_at: string;
    by_kind: Record<string, number>;
}

const source = (model: unknown, kind: string, plural: string, verb: string): ActivitySource => ({
    model: model as ActivityModel,
    kind,
    plural,
    verb,
});

const SOURCES: ActivitySource[] = [
    source(Server, "server", "Servers", "Added server"),
    source(Provision, "provision", "Provisions", "Provisioned"),
    source(Site, "site", "Sites", "Created site"),
    source(Deployment, "deployment", "Deployments", "Deployed"),
    source(SitePlugin, "plugin", "Plugins", "Installed plugin"),
    source(Provider, "provider", "Providers", "Connected provider"),
    source(Registrar, "registrar", "Registrars", "Connected registrar"),
    source(SourceProvider, "source_provider", "Git providers", "Connected git provider"),
    source(ServerDatabase, "database", "Databases", "Created database"),
    source(DbUser, "db_user", "Database users", "Created database user"),
    source(ServerCronJob, "cron", "Cron jobs", "Added cron job"),
    source(ServerWorker, "worker", "Workers", "Added worker"),
    source(ServerFirewallRule, "firewall", "Firewall rules", "Added firewall rule"),
    source(ServerSshKey, "server_key", "Server SSH keys", "Added SSH key to server"),
    source(SshKey, "ssh_key", "SSH keys", "Added SSH key"),
    source(ServerBackup, "backup", "Backups", "Created backup"),
    source(BackupStorage, "backup_storage", "Backup storage", "Added backup storage"),
];

/** Fields that are safe to show as a short label. Never add secrets here. */
const LABEL_FIELDS = ["name", "domain", "hostname", "host", "label", "title", "branch"];

function labelOf(row: ActivityRow): string {
    for (const field of LABEL_FIELDS) {
        const value = row[field];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
    }
    return `#${row.id}`;
}

export const TeamActivityService = {
    kinds(): { kind: string; plural: string }[] {
        return SOURCES.map((s) => ({ kind: s.kind, plural: s.plural }));
    },

    /** Every event for a team, newest first. */
    async collect(teamId: number): Promise<ActivityEvent[]> {
        const batches = await Promise.all(
            SOURCES.map(async (src): Promise<ActivityEvent[]> => {
                try {
                    const rows = (await src.model.query().where("team_id", teamId).get()) as ActivityRow[];
                    const out: ActivityEvent[] = [];

                    for (const row of rows) {
                        const userId = Number(row.user_id);
                        if (!Number.isInteger(userId) || userId < 1) continue;

                        const date = new Date(String(row.created_at));
                        if (Number.isNaN(date.getTime())) continue;

                        out.push({
                            id: `${src.kind}:${row.id}`,
                            user_id: userId,
                            kind: src.kind,
                            verb: src.verb,
                            label: labelOf(row),
                            at: date.toISOString(),
                        });
                    }

                    return out;
                } catch (error) {
                    console.error(`[activity] couldn't read ${src.kind}:`, error);
                    return [];
                }
            }),
        );

        return batches.flat().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    },

    /** Totals per user id. Events are expected newest first. */
    summarize(events: ActivityEvent[]): Record<string, ActivitySummary> {
        const out: Record<string, ActivitySummary> = {};

        for (const event of events) {
            const key = String(event.user_id);
            const entry = out[key] ?? { total: 0, last_at: event.at, by_kind: {} };
            entry.total += 1;
            if (event.at > entry.last_at) entry.last_at = event.at;
            entry.by_kind[event.kind] = (entry.by_kind[event.kind] ?? 0) + 1;
            out[key] = entry;
        }

        return out;
    },
};