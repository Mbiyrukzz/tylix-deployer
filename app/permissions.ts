// Who may do what in Tylix Deploy (@tylix/permissions).
//
// Roles come from team membership: a user's role in their CURRENT team
// (team_members.role: owner, admin or member) is their role here. There is
// nothing to assign or keep in sync: invite someone, change their role or
// switch teams, and their permissions follow on the next request. The
// catalogue below is the single list of permissions; it lives in memory and
// is applied when this file loads.
//
// Server:   await permissions.can(subjectOf(req), "invoices.export")
//           or requirePermission(req, res, "billing.manage") (TeamScope)
// Pages:    can("servers.manage"), hasRole("owner") in .tyx templates (from
//           user.access, which GET /api/me carries)
// Terminal: tylix permission:show
//
// requireRole(req, res, "admin") in the routes predates this file and means
// the same thing as the admin role below; both stay valid.
import { createPermissions, memoryStore } from "@tylix/permissions";
import type { PermissionStore, Assignments } from "@tylix/permissions";
import { TeamService } from "./services/TeamService.js";

export const definition = {
    permissions: [
        { name: "servers.view", description: "See servers, their stats, logs and settings" },
        { name: "servers.create", description: "Provision or connect a server" },
        { name: "servers.manage", description: "Change packages, firewall, workers, cron jobs, databases, SSH keys and backups" },
        { name: "servers.terminal", description: "Open a root terminal on a server" },
        { name: "servers.delete", description: "Delete a server" },
        { name: "sites.view", description: "See sites, deployments and logs" },
        { name: "sites.create", description: "Create a site on a server" },
        { name: "sites.manage", description: "Change a site's settings, SSL, redirects, nginx and environment" },
        { name: "sites.deploy", description: "Deploy, roll back and cancel deployments" },
        { name: "sites.terminal", description: "Open a terminal in a site's directory" },
        { name: "sites.delete", description: "Delete a site" },
        { name: "providers.view", description: "See cloud providers and their resources" },
        { name: "providers.manage", description: "Connect cloud providers and change their machines, volumes, IPs and firewalls" },
        { name: "domains.view", description: "See registrars, domains and DNS records" },
        { name: "domains.manage", description: "Connect registrars and change domains and DNS records" },
        { name: "source-control.manage", description: "Connect GitHub, GitLab or Bitbucket" },
        { name: "team.view", description: "See the team, its members and activity" },
        { name: "team.invite", description: "Invite people and cancel invitations" },
        { name: "team.manage", description: "Change members' roles and remove members" },
        { name: "billing.view", description: "See the plan, usage and invoices" },
        { name: "billing.manage", description: "Change the plan and payment methods" },
        { name: "invoices.download", description: "Download invoices as PDF" },
        { name: "invoices.export", description: "Export invoices to Excel" },
    ],
    roles: {
        member: {
            description: "Sees everything in the team, changes nothing",
            permissions: ["servers.view", "sites.view", "providers.view", "domains.view", "team.view", "billing.view"],
        },
        admin: {
            description: "Runs servers, sites, providers, domains and the team",
            inherits: ["member"],
            permissions: [
                "servers.*",
                "sites.*",
                "providers.*",
                "domains.*",
                "source-control.manage",
                "team.invite",
                "team.manage",
            ],
        },
        owner: {
            description: "Owns the team, its billing and invoices",
            inherits: ["admin"],
            permissions: ["billing.manage", "invoices.*"],
        },
    },
};

const TEAM_ROLES = new Set(["owner", "admin", "member"]);

// The catalogue (permissions and roles) is kept in memory; assignments are
// read from team membership, so they can't drift from what the team page shows.
function teamStore(): PermissionStore {
    const catalog = memoryStore();
    const none = (): Assignments => ({ roles: [], permissions: [] });

    return {
        loadCatalog: () => catalog.loadCatalog(),
        savePermission: (p) => catalog.savePermission(p),
        deletePermission: (name) => catalog.deletePermission(name),
        saveRole: (role) => catalog.saveRole(role),
        deleteRole: (name) => catalog.deleteRole(name),

        async getAssignments(subject) {
            const userId = Number(subject.id);
            if (!Number.isFinite(userId) || userId <= 0) return none();
            try {
                const ctx = await TeamService.contextFor(userId);
                const role = ctx ? String(ctx.role) : "";
                if (!TEAM_ROLES.has(role)) return none();
                return { roles: [{ name: role, team: null, expiresAt: null }], permissions: [] };
            } catch (err) {
                console.error("[permissions] team lookup failed:", err);
                return none();
            }
        },

        async setAssignments() {
            throw new Error("Roles in Tylix Deploy come from team membership: change them on the Team page (Settings → Team).");
        },

        async subjectsWithRole() {
            return [];
        },
    };
}

export const permissions = createPermissions({
    store: teamStore(),
    // Roles change when someone's team role changes or they switch teams,
    // so every check reads them fresh (one indexed lookup).
    cache: null,
    defaultRoles: [],
});

await permissions.sync(definition);

/** The permissions subject for a request (req.user carries userId, not id). */
export function subjectOf(req: { user?: { userId?: unknown } | null }): { id: number } | null {
    const id = Number(req.user?.userId);
    return Number.isFinite(id) && id > 0 ? { id } : null;
}
