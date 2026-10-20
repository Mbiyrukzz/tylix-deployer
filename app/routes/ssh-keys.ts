/**
 * SSH keys. Team-scoped: the key library is shared by the team, and a server
 * on another team answers 404. Any member can list keys and see which keys
 * are deployed; everything that changes access to a machine (adding or
 * deleting a key, deploying or removing one, listing server users over SSH)
 * needs the admin role.
 *
 * GET    /api/ssh-keys                              any member
 * POST   /api/ssh-keys                              admin (private key is returned once, never stored)
 * DELETE /api/ssh-keys/:id                          admin
 * GET    /api/servers/:id/ssh-users                 admin
 * GET    /api/servers/:id/ssh-keys                  any member
 * POST   /api/servers/:id/ssh-keys                  admin: deploy a key for a server user
 * DELETE /api/servers/:id/ssh-keys/:deploymentId    admin: remove it from the server
 */

import type { Router } from "@tylix/core";
import { createHash } from "node:crypto";
import { Server } from "../models/Server.js";
import { SshKey } from "../models/SshKey.js";
import { ServerSshKey } from "../models/ServerSshKey.js";
import { CryptoService } from "../services/CryptoService.js";
import { generateKeyPair, sshExec, type SshTarget } from "../services/Ssh.js";
import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";

type Handler = Parameters<Router["post"]>[1];
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

interface ServerRow {
    id: number; user_id: number; team_id: number | null; host: string; port: number; ssh_user: string; ssh_key: string;
    [key: string]: unknown;
}
interface KeyRow {
    id: number; user_id: number; team_id: number | null; name: string; public_key: string; fingerprint: string; created_at: string;
    [key: string]: unknown;
}
interface DeployRow {
    id: number; user_id: number; server_id: number; ssh_key_id: number; ssh_user: string; created_at: string;
    [key: string]: unknown;
}

const KEY_RE =
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: .*)?$/;
const UNIX_USER = /^[a-z_][a-z0-9_-]{0,31}$/i;

/** Accepts exactly one public key line; returns the canonical "type blob" or null. */
function parsePublicKey(raw: string) {
    const line = raw.trim();
    if (!line || line.includes("\n")) return null;
    const m = KEY_RE.exec(line);
    if (!m) return null;
    return { type: m[1], blob: m[2], canonical: `${m[1]} ${m[2]}` };
}

function fingerprint(blob: string): string {
    const hash = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
    return "SHA256:" + hash.replace(/=+$/, "");
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function preamble(user: string, blob: string): string[] {
    return [
        "set -e",
        `U=${sq(user)}`,
        `BLOB=${sq(blob)}`,
        'HOME_DIR=$(getent passwd "$U" | cut -d: -f6)',
        '[ -n "$HOME_DIR" ] || { echo "User $U does not exist on this server." >&2; exit 3; }',
        'GRP=$(id -gn "$U")',
        'F="$HOME_DIR/.ssh/authorized_keys"',
    ];
}

function deployScript(user: string, blob: string, line: string): string {
    return [
        ...preamble(user, blob),
        `LINE=${sq(line)}`,
        'install -d -m 700 -o "$U" -g "$GRP" "$HOME_DIR/.ssh"',
        'touch "$F"',
        'grep -qF "$BLOB" "$F" || printf "%s\\n" "$LINE" >> "$F"',
        'chown "$U:$GRP" "$F"',
        'chmod 600 "$F"',
    ].join("\n");
}

function revokeScript(user: string, blob: string): string {
    return [
        ...preamble(user, blob),
        '[ -f "$F" ] || exit 0',
        'grep -vF "$BLOB" "$F" > "$F.tylix" || true',
        'cat "$F.tylix" > "$F"',
        'rm -f "$F.tylix"',
    ].join("\n");
}

/** Wraps a script in sh -c, using sudo when we aren't root or the target user. */
function remote(connectUser: string, targetUser: string, script: string): string {
    const needsSudo = connectUser !== "root" && connectUser !== targetUser;
    return `${needsSudo ? "sudo -n " : ""}sh -c ${sq(script)}`;
}

function targetFor(server: ServerRow): SshTarget {
    return {
        host: server.host,
        port: Number(server.port),
        user: server.ssh_user,
        privateKey: CryptoService.decrypt(server.ssh_key),
    };
}

/** Loads a server and answers 404 itself if it is missing or not on the caller's team. */
async function ownedServer(req: Req, res: Res): Promise<ServerRow | null> {
    const teamId = requireTeam(req as any, res as any);
    if (!teamId) return null;

    const s = (await Server.find(req.params.id)) as ServerRow | null;
    if (!s || Number(s.team_id) !== teamId) {
        res.status(404);
        res.json({ error: "Server not found." });
        return null;
    }
    return s;
}

/** A key is on the team if its team matches; teamIdOfRow also covers keys saved before team_id existed. */
async function teamKey(teamId: number, id: unknown): Promise<KeyRow | null> {
    const k = (await SshKey.find(id as number)) as KeyRow | null;
    return k && (await teamIdOfRow(k)) === teamId ? k : null;
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    // ── key library (shared by the team) ───────────────────────────
    router.get("/api/ssh-keys", auth(async (req, res) => {
        const teamId = requireTeam(req as any, res as any);
        if (!teamId) return;

        const own: KeyRow[] = [];
        for (const k of (await SshKey.all()) as KeyRow[]) {
            if ((await teamIdOfRow(k)) === teamId) own.push(k);
        }
        own.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        return res.json(own);
    }));

    router.post("/api/ssh-keys", write(async (req, res) => {
        const teamId = requireTeam(req as any, res as any);
        if (!teamId) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const pasted = typeof body.public_key === "string" ? body.public_key.trim() : "";

        if (!name || name.length > 100) {
            res.status(422);
            return res.json({ error: "Give the key a name (100 characters or fewer)." });
        }

        let privateKey: string | undefined;
        let publicLine = pasted;

        if (!pasted) {
            const pair = await generateKeyPair(`tylix:${name}`);
            privateKey = pair.privateKey;
            publicLine = pair.publicKey;
        }

        const parsed = parsePublicKey(publicLine);
        if (!parsed) {
            res.status(422);
            return res.json({ error: "That doesn't look like a single-line SSH public key (ssh-ed25519, ssh-rsa, ecdsa…)." });
        }

        const fp = fingerprint(parsed.blob);
        let existing: KeyRow | null = null;
        for (const k of (await SshKey.all()) as KeyRow[]) {
            if (k.fingerprint === fp && (await teamIdOfRow(k)) === teamId) {
                existing = k;
                break;
            }
        }
        if (existing) {
            res.status(409);
            return res.json({ error: `Your team already added this key as "${existing.name}".` });
        }

        const key = (await SshKey.create({
            user_id: req.user?.userId,
            team_id: teamId,
            name,
            public_key: parsed.canonical,
            fingerprint: fp,
        })) as KeyRow | null;

        if (!key) {
            res.status(500);
            return res.json({ error: "Could not save the key." });
        }

        res.status(201);
        // private_key is returned ONCE here and never stored.
        return res.json({ key, private_key: privateKey ?? null });
    }));

    router.delete("/api/ssh-keys/:id", write(async (req, res) => {
        const teamId = requireTeam(req as any, res as any);
        if (!teamId) return;

        const key = await teamKey(teamId, req.params.id);
        if (!key) {
            res.status(404);
            return res.json({ error: "Key not found." });
        }
        const inUse = ((await ServerSshKey.all()) as DeployRow[]).some((d) => d.ssh_key_id === key.id);
        if (inUse) {
            res.status(409);
            return res.json({ error: "This key is still deployed on a server. Remove it from those servers first." });
        }
        await SshKey.delete(key.id);
        res.status(204);
        return res.end();
    }));

    // ── per-server ─────────────────────────────────────────────────
    router.get("/api/servers/:id/ssh-users", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const t = targetFor(server);
        const r = await sshExec(
            t,
            `awk -F: '$3==0 || ($3>=1000 && $3<65534) {print $1}' /etc/passwd`,
        );
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not connect to the server." });
        }
        return res.json(r.stdout.split("\n").map((u) => u.trim()).filter(Boolean));
    }));

    router.get("/api/servers/:id/ssh-keys", auth(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const keys = (await SshKey.all()) as KeyRow[];
        const rows = ((await ServerSshKey.all()) as DeployRow[])
            .filter((d) => d.server_id === server.id)
            .map((d) => {
                const k = keys.find((x) => x.id === d.ssh_key_id);
                return { ...d, name: k?.name ?? "(deleted key)", fingerprint: k?.fingerprint ?? "" };
            });
        return res.json(rows);
    }));

    router.post("/api/servers/:id/ssh-keys", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const user = typeof body.user === "string" ? body.user.trim() : "";
        if (!UNIX_USER.test(user)) {
            res.status(422);
            return res.json({ error: "Choose a valid server user." });
        }

        const key = await teamKey(Number(server.team_id), body.ssh_key_id);
        if (!key) {
            res.status(404);
            return res.json({ error: "Key not found." });
        }

        const already = ((await ServerSshKey.all()) as DeployRow[]).some(
            (d) => d.server_id === server.id && d.ssh_key_id === key.id && d.ssh_user === user,
        );
        if (already) {
            res.status(409);
            return res.json({ error: `"${key.name}" is already deployed for ${user} on this server.` });
        }

        const parsed = parsePublicKey(key.public_key);
        if (!parsed) {
            res.status(500);
            return res.json({ error: "Stored key is invalid." });
        }

        const comment = key.name.replace(/[^a-zA-Z0-9_.-]/g, "-");
        const line = `${parsed.canonical} tylix:${comment}`;
        const t = targetFor(server);
        const r = await sshExec(t, remote(t.user, user, deployScript(user, parsed.blob, line)));

        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Deploying the key failed." });
        }

        const row = await ServerSshKey.create({
            user_id: req.user?.userId,
            server_id: server.id,
            ssh_key_id: key.id,
            ssh_user: user,
        });
        res.status(201);
        return res.json(row);
    }));

    router.delete("/api/servers/:id/ssh-keys/:deploymentId", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        // A deployment belongs to the team of its server, so checking the server is enough.
        const dep = (await ServerSshKey.find(req.params.deploymentId)) as DeployRow | null;
        if (!dep || dep.server_id !== server.id) {
            res.status(404);
            return res.json({ error: "Deployment not found." });
        }

        const key = (await SshKey.find(dep.ssh_key_id)) as KeyRow | null;
        const parsed = key ? parsePublicKey(key.public_key) : null;

        if (parsed) {
            const t = targetFor(server);
            const r = await sshExec(t, remote(t.user, dep.ssh_user, revokeScript(dep.ssh_user, parsed.blob)));
            if (r.code !== 0) {
                res.status(502);
                return res.json({ error: r.stderr.trim() || "Could not remove the key from the server." });
            }
        }

        await ServerSshKey.delete(dep.id);
        res.status(204);
        return res.end();
    }));
}