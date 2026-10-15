/**
 * Web terminal on the Tylix channel server ("terminal" channel).
 *
 * Protocol (JSON both ways):
 *   browser -> server  { t: "auth", ticket }   must be the first message
 *                      { t: "i", d: "<keystrokes>" }
 *   server  -> browser { t: "ready" }           first output arrived, shell is up
 *                      { t: "out", d: "<base64 output>" }
 *                      { t: "exit", m: "<message>" }  then the socket closes
 *
 * Until a valid ticket arrives the socket is unauthenticated and everything
 * else is ignored; it is closed after 10 seconds. After auth the site or
 * server is re-read from the database and must belong to the ticket's user.
 *
 * Two kinds of session, chosen by the ticket:
 *   site terminal    ssh -tt to the site's server, as the site's isolated
 *                    user, in the site folder
 *   server terminal  ssh -tt to the server, as the server's own ssh user
 *                    (a normal login shell)
 *
 * The SSH key sits in a 0600 temp file only until the first output arrives.
 * Limits: 3 terminals per user, 15 minutes idle. The terminal size is fixed
 * at connect time.
 *
 * Any failure while opening a session ends that session only; it never
 * takes the channel server down.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { serverTarget } from "./Shell.js";
import { verifyTicket, terminalConfigured } from "./TerminalTicket.js";
import type { TicketPayload } from "./TerminalTicket.js";

interface Socket {
    readyState: number;
    OPEN: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

interface Handlers {
    onConnect?(ws: Socket): void;
    onMessage?(ws: Socket, data: unknown): void;
    onDisconnect?(ws: Socket): void;
}

export interface ChannelHost {
    channel(name: string, handlers: Handlers): unknown;
}

interface SiteRow {
    id: number;
    user_id: number;
    server_id: number;
    domain: string;
    isolated_user: string;
    status: string;
    [key: string]: unknown;
}

interface ServerRecord {
    user_id: number;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
}

interface Session {
    authed: boolean;
    counted: boolean;
    finished: boolean;
    userId: number;
    proc: ChildProcess | null;
    dir: string;
    idle: ReturnType<typeof setTimeout> | undefined;
    authTimer: ReturnType<typeof setTimeout> | undefined;
}

const AUTH_MS = 10_000;
const IDLE_MS = 15 * 60_000;
const MAX_SESSIONS_PER_USER = 3;
const MAX_INPUT = 64 * 1024;

const USER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const sessions = new WeakMap<Socket, Session>();
const perUser = new Map<number, number>();
const usedNonces = new Map<string, number>();

function send(ws: Socket, message: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function wipeKey(s: Session): void {
    if (!s.dir) return;
    const d = s.dir;
    s.dir = "";
    void rm(d, { recursive: true, force: true });
}

/** Ends a session once: cleans up, tells the browser why, closes the socket. */
function finish(ws: Socket, s: Session, message: string): void {
    if (s.finished) return;
    s.finished = true;

    if (s.idle) clearTimeout(s.idle);
    if (s.authTimer) clearTimeout(s.authTimer);
    wipeKey(s);

    if (s.counted) {
        perUser.set(s.userId, Math.max(0, (perUser.get(s.userId) ?? 1) - 1));
        s.counted = false;
    }

    if (s.proc && s.proc.exitCode === null) s.proc.kill("SIGTERM");

    send(ws, { t: "exit", m: message });
    ws.close();
}

/** Site terminal: size the PTY, then drop to the site user in the site folder. */
function siteCommand(user: string, domain: string, cols: number, rows: number): string {
    // user and domain are validated against strict patterns before this is called.
    const inner = `cd "$HOME/${domain}" && exec bash -l`;
    return (
        `stty cols ${cols} rows ${rows} 2>/dev/null; ` +
        `if [ "$(id -u)" -eq 0 ]; then ` +
        `exec runuser -u ${user} -- env HOME=/home/${user} bash -lc '${inner}'; ` +
        `else exec sudo -u ${user} -H bash -lc '${inner}'; fi`
    );
}

/** Server terminal: size the PTY, then a normal login shell for the ssh user. */
function serverCommand(cols: number, rows: number): string {
    // cols and rows are integers (checked when the ticket is verified).
    return `stty cols ${cols} rows ${rows} 2>/dev/null; exec "\${SHELL:-/bin/bash}" -l`;
}

async function begin(ws: Socket, s: Session, ticket: TicketPayload): Promise<void> {
    const now = Date.now();
    for (const [nonce, exp] of usedNonces) {
        if (exp < now) usedNonces.delete(nonce);
    }
    if (usedNonces.has(ticket.n)) {
        finish(ws, s, "This terminal link was already used. Click Connect again.");
        return;
    }
    usedNonces.set(ticket.n, ticket.e);

    s.userId = ticket.u;
    const open = perUser.get(ticket.u) ?? 0;
    if (open >= MAX_SESSIONS_PER_USER) {
        finish(ws, s, "Too many open terminals. Close one and try again.");
        return;
    }
    s.counted = true;
    perUser.set(ticket.u, open + 1);

    let server: ServerRecord | null;
    let command: string;
    let label: string;

    if (ticket.v) {
        // ---- server terminal ----
        server = (await Server.find(ticket.v)) as ServerRecord | null;
        if (s.finished) return;
        if (!server || server.user_id !== ticket.u) {
            finish(ws, s, "Server not found.");
            return;
        }

        command = serverCommand(ticket.c, ticket.r);
        label = `${server.ssh_user}@${server.host}`;
    } else {
        // ---- site terminal ----
        const site = (await Site.find(ticket.s)) as SiteRow | null;
        if (s.finished) return;
        if (!site || site.user_id !== ticket.u || site.status !== "ready") {
            finish(ws, s, "Site not found.");
            return;
        }
        if (!USER_RE.test(String(site.isolated_user)) || !DOMAIN_RE.test(String(site.domain))) {
            finish(ws, s, "This site has an invalid user or domain.");
            return;
        }

        server = (await Server.find(site.server_id)) as ServerRecord | null;
        if (s.finished) return;
        if (!server) {
            finish(ws, s, "The server no longer exists.");
            return;
        }

        command = siteCommand(site.isolated_user, site.domain, ticket.c, ticket.r);
        label = `${site.isolated_user}@${site.domain}`;
    }

    const target = serverTarget(server as never);
    const dir = await mkdtemp(join(tmpdir(), "tylix-term-"));
    s.dir = dir;
    if (s.finished) {
        wipeKey(s);
        return;
    }

    const keyFile = join(dir, "key");
    await writeFile(keyFile, target.privateKey.endsWith("\n") ? target.privateKey : target.privateKey + "\n", {
        mode: 0o600,
    });

    const args = [
        "-tt",
        "-i", keyFile,
        "-p", String(target.port),
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`,
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=30",
        "-o", "LogLevel=ERROR",
        `${target.user}@${target.host}`,
        command,
    ];

    const proc = spawn("ssh", args, { env: { ...process.env, TERM: "xterm-256color" } });
    s.proc = proc;
    proc.stdin?.on("error", () => {});

    let ready = false;
    const forward = (chunk: Buffer) => {
        wipeKey(s);
        if (!ready) {
            ready = true;
            send(ws, { t: "ready" });
        }
        send(ws, { t: "out", d: chunk.toString("base64") });
    };
    proc.stdout?.on("data", forward);
    proc.stderr?.on("data", forward);
    proc.on("error", () => finish(ws, s, "Couldn't start ssh on the deployer host."));
    proc.on("close", (code) => finish(ws, s, code ? `Session ended (exit ${code}).` : "Session ended."));

    s.idle = setTimeout(() => finish(ws, s, "Closed after 15 minutes of inactivity."), IDLE_MS);

    console.log(`[terminal] opened ${label} for user ${ticket.u}`);
}

function bumpIdle(ws: Socket, s: Session): void {
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => finish(ws, s, "Closed after 15 minutes of inactivity."), IDLE_MS);
}

export function registerTerminal(server: ChannelHost): void {
    if (!terminalConfigured()) {
        console.error("[terminal] TERMINAL_SECRET is not set in this process. Terminals will refuse to open.");
    }

    server.channel("terminal", {
        onConnect(ws) {
            const s: Session = {
                authed: false,
                counted: false,
                finished: false,
                userId: 0,
                proc: null,
                dir: "",
                idle: undefined,
                authTimer: undefined,
            };
            s.authTimer = setTimeout(() => finish(ws, s, "Not authenticated in time."), AUTH_MS);
            sessions.set(ws, s);
        },

        onMessage(ws, data) {
            const s = sessions.get(ws);
            if (!s || s.finished || typeof data !== "object" || data === null) return;
            const message = data as { t?: unknown; ticket?: unknown; d?: unknown };

            if (!s.authed) {
                if (message.t !== "auth" || typeof message.ticket !== "string") return;

                const ticket = verifyTicket(message.ticket);
                if (!ticket) {
                    finish(ws, s, "This terminal link expired. Click Connect again.");
                    return;
                }

                s.authed = true;
                if (s.authTimer) clearTimeout(s.authTimer);

                begin(ws, s, ticket).catch((error) => {
                    console.error("[terminal] failed to open:", error instanceof Error ? error.message : error);
                    finish(ws, s, "Couldn't start the terminal.");
                });
                return;
            }

            if (message.t === "i" && typeof message.d === "string" && message.d.length <= MAX_INPUT) {
                s.proc?.stdin?.write(message.d);
                bumpIdle(ws, s);
            }
        },

        onDisconnect(ws) {
            const s = sessions.get(ws);
            if (s) finish(ws, s, "Connection closed.");
        },
    });
}