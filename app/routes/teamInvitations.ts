/**
 * Team invitations.
 *
 * POST   /api/team/invitations            invite by email (owner or admin)
 * GET    /api/team/invitations            pending invites (owner or admin)
 * DELETE /api/team/invitations/:id        revoke (owner or admin)
 * GET    /api/team/invitations/preview    ?token=  what accepting would do (read-only)
 * POST   /api/team/invitations/accept     { token, confirm: true }
 */

import type { Router } from "@tylix/core";
import { User } from "../models/User.js";
import { TeamInvitation, type TeamInvitationAttributes } from "../models/TeamInvitation.js";
import { TeamService } from "../services/TeamService.js";
import { TeamInvitationService, InviteError } from "../services/TeamInvitationService.js";
import { inviteUrl, sendTeamInviteEmail } from "../mail/mailer.js";

type Handler = Parameters<Router["get"]>[1];

const mailConfig = {
    driver: (process.env.MAIL_DRIVER === "smtp" ? "smtp" : "log") as "log" | "smtp",
    from: process.env.MAIL_FROM || "noreply@example.com",
    host: process.env.MAIL_HOST || "",
    port: Number(process.env.MAIL_PORT) || 587,
    user: process.env.MAIL_USER || "",
    password: process.env.MAIL_PASSWORD || "",
    secure: process.env.MAIL_SECURE === "true",
};

console.log("[mail] driver:", mailConfig.driver, "host:", mailConfig.host, "user:", mailConfig.user);

const toPublic = (i: TeamInvitationAttributes) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    expires_at: i.expires_at,
    created_at: i.created_at,
});

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    const handle = (fn: Handler): Handler =>
        (async (req, res) => {
            try {
                return await (fn as any)(req, res);
            } catch (error) {
                if (error instanceof InviteError) {
                    return res.status(error.status).json({ error: error.message, ...error.extra });
                }
                console.error("[team-invitations]", error);
                return res.status(500).json({ error: "Something went wrong." });
            }
        }) as Handler;

    /** The caller and their team, answering 403 itself unless they are owner or admin. */
    async function adminContext(req: any, res: any) {
        const user = await User.find(req.user!.userId as number);
        if (!user) {
            res.status(404).json({ error: "Account not found." });
            return null;
        }
        const ctx = await TeamService.ensureTeam(user);
        if (!TeamService.can(ctx.role, "admin")) {
            res.status(403).json({ error: "Only team owners and admins can manage invitations." });
            return null;
        }
        return { user, ...ctx };
    }

    router.post(
        "/api/team/invitations",
        auth(handle(async (req, res) => {
            const c = await adminContext(req, res);
            if (!c) return;

            const email = typeof req.body?.email === "string" ? req.body.email : "";
            const role = typeof req.body?.role === "string" ? req.body.role : "member";

            const { invitation, token } = await TeamInvitationService.create(c.team, c.user.id, email, role);
            const acceptUrl = inviteUrl(token);

            let emailSent = true;
            try {
                await sendTeamInviteEmail(
                    invitation.email,
                    { teamName: c.team.name, inviterName: c.user.name, role: invitation.role, acceptUrl },
                    mailConfig,
                );
            } catch (error) {
                emailSent = false;
                console.error("[team-invitations] email failed:", {
  message: error instanceof Error ? error.message : String(error),
  code: (error as NodeJS.ErrnoException)?.code,
  stack: error instanceof Error ? error.stack : undefined,
});
            }

            // The link is returned to the inviter so they can copy it if mail isn't working.
            return res.status(201).json({ invitation: toPublic(invitation), email_sent: emailSent, link: acceptUrl });
        })),
    );

    router.get(
        "/api/team/invitations",
        auth(handle(async (req, res) => {
            const c = await adminContext(req, res);
            if (!c) return;
            return res.json((await TeamInvitationService.pending(c.team.id)).map(toPublic));
        })),
    );

    router.delete(
        "/api/team/invitations/:id",
        auth(handle(async (req, res) => {
            const c = await adminContext(req, res);
            if (!c) return;

            const inv = (await TeamInvitation.find(req.params.id)) as TeamInvitationAttributes | null;
            if (!inv || Number(inv.team_id) !== c.team.id || inv.accepted_at) {
                return res.status(404).json({ error: "Invitation not found." });
            }

            await TeamInvitation.delete(inv.id);
            res.status(204);
            return res.end();
        })),
    );

    router.get(
        "/api/team/invitations/preview",
        auth(handle(async (req, res) => {
            const user = await User.find(req.user!.userId as number);
            if (!user) return res.status(404).json({ error: "Account not found." });

            const query = (req as unknown as { query?: Record<string, string> }).query ?? {};
            const info = await TeamInvitationService.inspect(String(query.token ?? ""), user);

            return res.json({
                team: { id: info.team.id, name: info.team.name },
                role: info.invitation.role,
                already_member: info.alreadyMember,
                blocked: info.blocked,
                counts: info.counts,
                total: info.total,
                conflicts: info.conflicts,
            });
        })),
    );

    router.post(
        "/api/team/invitations/accept",
        auth(handle(async (req, res) => {
            const user = await User.find(req.user!.userId as number);
            if (!user) return res.status(404).json({ error: "Account not found." });

            const token = typeof req.body?.token === "string" ? req.body.token : "";
            const { team } = await TeamInvitationService.accept(token, user, req.body?.confirm === true);

            return res.json({ team: { id: team.id, name: team.name } });
        })),
    );
}