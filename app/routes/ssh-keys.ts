import type { Router } from "@tylix/core";
import { createHash } from "node:crypto";
import { Server } from "../models/Server.js";
import { SshKey } from "../models/SshKey.js";
import { ServerSshKey } from "../models/ServerSshKey.js";
import { CryptoService } from "../services/CryptoService.js";
import { generateKeyPair, sshExec, type SshTarget } from "../services/Ssh.js";

type Handler = Parameters<Router["post"]>[1];
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

interface ServerRow { id: number; user_id: number; host: string; port: number; ssh_user: string; ssh_key: string }
interface KeyRow { id: number; user_id: number; name: string; public_key: string; fingerprint: string; created_at: string }
interface DeployRow { id: number; user_id: number; server_id: number; ssh_key_id: number; ssh_user: string; created_at: string }
interface ServerRow { id: number; user_id: number; host: string; port: number; ssh_user: string; ssh_key: string; [key: string]: unknown }
interface KeyRow { id: number; user_id: number; name: string; public_key: string; fingerprint: string; created_at: string; [key: string]: unknown }
interface DeployRow { id: number; user_id: number; server_id: number; ssh_key_id: number; ssh_user: string; created_at: string; [key: string]: unknown }

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

async function ownedServer(req: Req, res: Res): Promise<ServerRow | null> {
    const s = (await Server.find(req.params.id)) as ServerRow | null;
    if (!s || s.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Server not found." });
        return null;
    }
    return s;
}

async function ownedKey(userId: unknown, id: unknown): Promise<KeyRow | null> {
    const k = (await SshKey.find(id as number)) as KeyRow | null;
    return k && k.user_id === userId ? k : null;
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // ── key library ────────────────────────────────────────────────
    router.get("/api/ssh-keys", auth(async (req, res) => {
        const keys = ((await SshKey.all()) as KeyRow[])
            .filter((k) => k.user_id === req.user?.userId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        return res.json(keys);
    }));

    router.post("/api/ssh-keys", auth(async (req, res) => {
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
        const existing = ((await SshKey.all()) as KeyRow[]).find(
            (k) => k.user_id === req.user?.userId && k.fingerprint === fp,
        );
        if (existing) {
            res.status(409);
            return res.json({ error: `You already added this key as "${existing.name}".` });
        }

        const key = (await SshKey.create({
            user_id: req.user?.userId,
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

    router.delete("/api/ssh-keys/:id", auth(async (req, res) => {
        const key = await ownedKey(req.user?.userId, req.params.id);
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
    router.get("/api/servers/:id/ssh-users", auth(async (req, res) => {
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

    router.post("/api/servers/:id/ssh-keys", auth(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const user = typeof body.user === "string" ? body.user.trim() : "";
        if (!UNIX_USER.test(user)) {
            res.status(422);
            return res.json({ error: "Choose a valid server user." });
        }

        const key = await ownedKey(req.user?.userId, body.ssh_key_id);
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

    router.delete("/api/servers/:id/ssh-keys/:deploymentId", auth(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const dep = (await ServerSshKey.find(req.params.deploymentId)) as DeployRow | null;
        if (!dep || dep.server_id !== server.id || dep.user_id !== req.user?.userId) {
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