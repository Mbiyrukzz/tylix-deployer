/**
 * Service: TeamService
 *
 * Every resource in the deployer belongs to a team, and (later) the
 * subscription belongs to the team too. A personal account is just a team
 * with one member.
 *
 * Roles: owner > admin > member. The owner is the billing contact.
 *
 * ensureTeam() creates a personal team lazily the first time a user needs
 * one, so existing users need no backfill and the generated auth code
 * stays untouched. It also stamps team_id onto rows the user created before
 * teams existed (adoptLegacyRows), once per user per server process.
 * Remove that call once every active user has been through it.
 */

import { randomBytes } from "node:crypto";
import { Team } from "../models/Team.js";
import type { TeamAttributes } from "../models/Team.js";
import { TeamMember } from "../models/TeamMember.js";
import type { TeamMemberAttributes } from "../models/TeamMember.js";
import { User } from "../models/User.js";
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
import { ServerLog } from "../models/ServerLog.js";
import { ServerSshKey } from "../models/ServerSshKey.js";
import { ServerTask } from "../models/ServerTask.js";
import { ServerWorker } from "../models/ServerWorker.js";
import { Site } from "../models/Site.js";
import { SitePlugin } from "../models/SitePlugin.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { SshKey } from "../models/SshKey.js";
import { BillingService } from "./BillingService.js";

export type TeamRole = "owner" | "admin" | "member";

export interface TeamContext {
    team: TeamAttributes;
    role: TeamRole;
}

export interface TeamMemberView {
    id: number;
    name: string;
    email: string;
    role: TeamRole;
    joined_at: string;
}

interface OwnedRow {
    id: number;
    team_id?: number | null;
}

interface OwnedModel {
    query(): { where(column: string, value: unknown): { get(): Promise<unknown> } };
    update(id: number, data: Record<string, unknown>): Promise<unknown>;
}

// Every model whose rows carry user_id + team_id.
const OWNED_MODELS: OwnedModel[] = [
    BackupStorage,
    DbUser,
    Deployment,
    Provider,
    Provision,
    Registrar,
    Server,
    ServerBackup,
    ServerCronJob,
    ServerDatabase,
    ServerFirewallRule,
    ServerLog,
    ServerSshKey,
    ServerTask,
    ServerWorker,
    Site,
    SitePlugin,
    SourceProvider,
    SshKey,
].map((model) => model as unknown as OwnedModel);

/** "userId:teamId" pairs already adopted in this process. */
const adopted = new Set<string>();

const ROLE_RANK: Record<TeamRole, number> = { owner: 3, admin: 2, member: 1 };

function slugify(value: string): string {
    const base = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return base || "team";
}

export class TeamService {
    /** True when `role` is at least `minimum` (owner >= admin >= member). */
    static can(role: TeamRole, minimum: TeamRole): boolean {
        return ROLE_RANK[role] >= ROLE_RANK[minimum];
    }

    static makeSlug(name: string): string {
        return `${slugify(name)}-${randomBytes(3).toString("hex")}`;
    }

    static async membershipsFor(userId: number): Promise<TeamMemberAttributes[]> {
        const rows = (await TeamMember.query().where("user_id", userId).get()) as TeamMemberAttributes[];
        return [...rows].sort((a, b) => a.id - b.id);
    }

    static async membership(teamId: number, userId: number): Promise<TeamMemberAttributes | null> {
        const rows = (await TeamMember.query().where("team_id", teamId).get()) as TeamMemberAttributes[];
        return rows.find((row) => row.user_id === userId) ?? null;
    }

    static async createTeam(user: { id: number; name: string }, name: string): Promise<TeamContext> {
        const team = await Team.create({
            name,
            slug: this.makeSlug(name),
            owner_id: user.id,
        });
        if (!team) throw new Error("Failed to create team.");

        await TeamMember.create({ team_id: team.id, user_id: user.id, role: "owner" });
        return { team, role: "owner" };
    }

    /**
     * Stamps team_id onto rows this user created before teams existed.
     * Only rows with no team_id are touched, so it is safe to run repeatedly.
     * Runs once per user per process.
     */
    static async adoptLegacyRows(userId: number, teamId: number): Promise<void> {
        const key = `${userId}:${teamId}`;
        if (adopted.has(key)) return;

        for (const model of OWNED_MODELS) {
            const rows = (await model.query().where("user_id", userId).get()) as OwnedRow[];
            for (const row of rows) {
                if (!row.team_id) {
                    await model.update(row.id, { team_id: teamId });
                }
            }
        }

        adopted.add(key);
    }

    /**
     * The team this user is currently working in. For now that is their first
     * membership (their personal team). A team switcher comes later.
     */
    static async ensureTeam(user: { id: number; name: string; created_at?: string | Date }): Promise<TeamContext> {
        const memberships = await this.membershipsFor(user.id);

let context: TeamContext | null = null;

if (memberships.length > 0) {
    // Prefer a team the user was invited into over one they own (their personal team).
    let chosen: { team: TeamAttributes; role: TeamRole } | null = null;

    for (const m of memberships) {
        const team = await Team.find(m.team_id);
        if (!team) continue;
        const joined = Number(team.owner_id) !== user.id;
        if (joined) {
            chosen = { team, role: m.role as TeamRole };
            break;
        }
        if (!chosen) chosen = { team, role: m.role as TeamRole };
    }

    if (chosen) context = chosen;
}

        if (!context) {
            const label = user.name?.trim() ? `${user.name.trim()}'s team` : "My team";
            context = await this.createTeam(user, label);

            // New accounts get a free trial. A billing problem must never stop a team from being created.
            try {
                await BillingService.startTrialFor(context.team.id, user);
            } catch (error) {
                console.error("[billing] couldn't start the trial:", error);
            }
        }

        // Only a team's owner adopts their old rows; members never do.
        if (context.role === "owner") {
            await this.adoptLegacyRows(user.id, context.team.id);
        }

        return context;
    }

    /** Loads the user and resolves their current team in one call. Null if the user is gone. */
    static async contextFor(userId: number): Promise<TeamContext | null> {
        const user = await User.find(userId);
        if (!user) return null;
        return this.ensureTeam(user);
    }

        /** Row counts per table for everything a team owns (the invite consent screen shows these). */
    static async ownedCounts(teamId: number): Promise<Record<string, number>> {
        const out: Record<string, number> = {};
        for (const model of OWNED_MODELS) {
            const rows = (await model.query().where("team_id", teamId).get()) as OwnedRow[];
            if (rows.length > 0) out[(model as unknown as { table: string }).table] = rows.length;
        }
        return out;
    }

    /** Restamps every row of one team onto another. Safe to re-run: moved rows no longer match. */
    static async moveOwned(fromTeamId: number, toTeamId: number): Promise<void> {
        for (const model of OWNED_MODELS) {
            const rows = (await model.query().where("team_id", fromTeamId).get()) as OwnedRow[];
            for (const row of rows) {
                await model.update(row.id, { team_id: toTeamId });
            }
        }
    }

    static async members(teamId: number): Promise<TeamMemberView[]> {
        const rows = (await TeamMember.query().where("team_id", teamId).get()) as TeamMemberAttributes[];
        const out: TeamMemberView[] = [];

        for (const row of rows) {
            const user = await User.find(row.user_id);
            if (!user) continue;
            out.push({
                id: user.id,
                name: user.name,
                email: user.email,
                role: row.role as TeamRole,
                joined_at: row.created_at,
            });
        }

        return out.sort(
            (a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name),
        );
    }
}