/**
 * Service: TeamInvitationService
 *
 * Invitations are emailed links. Only a SHA-256 hash of the token is stored.
 * Accepting moves everything the invitee owns in their personal team into
 * the new team, then retires the empty personal team (ensureTeam() picks a
 * user's first membership, so leaving it in place would keep them in it).
 *
 * Rules:
 *   - the accepting account's email must match the invited email
 *   - the move needs the invitee to be the only member of their current team
 *   - a host:port or provider-label clash with the new team blocks the accept
 *   - nothing changes without confirm: true; inspect() is read-only
 *
 * The ORM has no transactions, so accept() is written to be re-runnable.
 */

import { createHash, randomBytes } from "node:crypto";
import { Team } from "../models/Team.js";
import { TeamMember } from "../models/TeamMember.js";
import { TeamInvitation, type TeamInvitationAttributes } from "../models/TeamInvitation.js";
import { Server } from "../models/Server.js";
import { Provider } from "../models/Provider.js";
import { TeamService } from "./TeamService.js";
import type { TeamAttributes } from "../models/Team.js";

const INVITE_DAYS = 7;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InviteError extends Error {
    constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
        super(message);
    }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");


export interface InviteInfo {
    invitation: TeamInvitationAttributes;
    team: TeamAttributes;
    personalTeamId: number;
    alreadyMember: boolean;
    blocked: string;
    counts: Record<string, number>;
    total: number;
    conflicts: string[];
}

export class TeamInvitationService {
    static async pending(teamId: number): Promise<TeamInvitationAttributes[]> {
    const rows = (await TeamInvitation.query().where("team_id", teamId).get()) as TeamInvitationAttributes[];
    const now = new Date().toISOString();

    const memberEmails = new Set(
        (await TeamService.members(teamId)).map((m) => m.email.toLowerCase()),
    );

    return rows
        .filter((r) => !r.accepted_at && r.expires_at > now && !memberEmails.has(r.email))
        .sort((a, b) => b.id - a.id);
}

    /** Creates (or replaces) the pending invite for this email. Returns the raw token once. */
    static async create(team: TeamAttributes, inviterId: number, emailRaw: string, role: string) {
        const email = emailRaw.trim().toLowerCase();
        if (!EMAIL.test(email) || email.length > 190) {
            throw new InviteError(422, "Enter a valid email address.");
        }
        if (role !== "admin" && role !== "member") {
            throw new InviteError(422, "Role must be admin or member.");
        }

        const members = await TeamService.members(team.id);
        if (members.some((m) => m.email.toLowerCase() === email)) {
            throw new InviteError(409, "That person is already on your team.");
        }

        for (const p of await this.pending(team.id)) {
            if (p.email === email) await TeamInvitation.delete(p.id);
        }

        const token = randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();

        const invitation = (await TeamInvitation.create({
            team_id: team.id,
            email,
            role,
            token_hash: hashToken(token),
            invited_by: inviterId,
            expires_at: expires,
            accepted_at: "",
        })) as TeamInvitationAttributes | null;

        if (!invitation) throw new InviteError(500, "Could not save the invitation.");
        return { invitation, token };
    }

    static async findByToken(token: string): Promise<TeamInvitationAttributes> {
        const rows = (await TeamInvitation.query()
            .where("token_hash", hashToken(token))
            .get()) as TeamInvitationAttributes[];
        const inv = rows[0];

        if (!inv) throw new InviteError(404, "This invitation link isn't valid.");
        if (inv.accepted_at) throw new InviteError(410, "This invitation was already used.");
        if (inv.expires_at <= new Date().toISOString()) {
            throw new InviteError(410, "This invitation has expired. Ask for a new one.");
        }
        return inv;
    }

    /** Read-only: what accepting would do. */
    static async inspect(token: string, user: { id: number; name: string; email: string }): Promise<InviteInfo> {
        const invitation = await this.findByToken(token);

        if (user.email.trim().toLowerCase() !== invitation.email) {
            throw new InviteError(403, "This invitation was sent to a different email address. Log in with that account.");
        }

        const team = await Team.find(invitation.team_id);
        if (!team) throw new InviteError(410, "That team no longer exists.");

        const ctx = await TeamService.ensureTeam(user);
        const base = { invitation, team, personalTeamId: ctx.team.id };

       if (ctx.team.id === team.id) {
    return { ...base, alreadyMember: true, blocked: "", counts: {}, total: 0, conflicts: [] };
}

        const soleOwner =
            ctx.role === "owner" && (await TeamService.members(ctx.team.id)).length === 1;
        if (!soleOwner) {
            return {
                ...base,
                alreadyMember: false,
                blocked: "Your current team has other people in it. Leave it before joining another team.",
                counts: {},
                total: 0,
                conflicts: [],
            };
        }

        const counts = await TeamService.ownedCounts(ctx.team.id);
        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        return {
            ...base,
            alreadyMember: false,
            blocked: "",
            counts,
            total,
            conflicts: await this.conflicts(ctx.team.id, team.id),
        };
    }

    /** Things that would clash once the invitee's rows sit next to the team's. */
    private static async conflicts(fromTeamId: number, toTeamId: number): Promise<string[]> {
        const out: string[] = [];

        const mine = (await Server.query().where("team_id", fromTeamId).get()) as { name: string; host: string; port: number }[];
        const theirs = (await Server.query().where("team_id", toTeamId).get()) as { host: string; port: number }[];
        for (const s of mine) {
            if (theirs.some((t) => t.host === s.host && Number(t.port) === Number(s.port))) {
                out.push(`Server "${s.name}" (${s.host}:${s.port}) is already on the team.`);
            }
        }

        const myProviders = (await Provider.query().where("team_id", fromTeamId).get()) as { label: string }[];
        const teamProviders = (await Provider.query().where("team_id", toTeamId).get()) as { label: string }[];
        for (const p of myProviders) {
            if (teamProviders.some((t) => t.label.toLowerCase() === p.label.toLowerCase())) {
                out.push(`Provider connection "${p.label}" has the same name as one on the team. Rename it first.`);
            }
        }

        return out;
    }

    static async accept(token: string, user: { id: number; name: string; email: string }, confirmed: boolean) {
        const info = await this.inspect(token, user);

        if (info.blocked) throw new InviteError(409, info.blocked);
        if (info.conflicts.length > 0) {
            throw new InviteError(409, "Some of your servers or connections clash with the team's.", {
                conflicts: info.conflicts,
            });
        }
        if (!info.alreadyMember && !confirmed) {
            throw new InviteError(422, "Confirm that you want to join and move your data.");
        }

        const { invitation, team, personalTeamId } = info;

        if (!info.alreadyMember) {
            await TeamService.moveOwned(personalTeamId, team.id);

            if (!(await TeamService.membership(team.id, user.id))) {
                await TeamMember.create({ team_id: team.id, user_id: user.id, role: invitation.role });
            }

            // Retire the personal team only once it is verifiably empty.
            const left = await TeamService.ownedCounts(personalTeamId);
            if (Object.keys(left).length === 0) {
                const mine = await TeamService.membership(personalTeamId, user.id);
                if (mine) await TeamMember.delete(mine.id);
                await Team.delete(personalTeamId);
            } else {
                throw new InviteError(500, "Joined the team, but some data couldn't be moved. Nothing was deleted.");
            }
        }

        await TeamInvitation.update(invitation.id, { accepted_at: new Date().toISOString() });
        return { team };
    }
}