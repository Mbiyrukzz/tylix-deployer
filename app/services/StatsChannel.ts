/**
 * Live server stats on the Tylix channel server ("serverstats" channel).
 *
 * Protocol (JSON both ways):
 *   browser -> server  { t: "auth", ticket }     must be the first message
 *   server  -> browser { t: "ready" }            ticket accepted
 *                      { t: "stats", d: {...} }  pushed every few seconds
 *                      { t: "error", m: "..." }  server unreachable / unreadable
 *                      { t: "exit", m: "..." }   then the socket closes
 *
 * One poller (one SSH connection at a time) runs per server no matter how many
 * browsers are watching. It starts with the first viewer and stops with the
 * last. After auth the server is re-read from the database and must belong to
 * the same team as the ticket's user.
 */

import { Server } from "../models/Server.js";
import { readStats } from "./ServerStats.js";
import type { StatsServer } from "./ServerStats.js";
import { teamIdOfRow } from "./TeamScope.js";
import { verifyStatsTicket } from "./StatsTicket.js";
import type { StatsTicketPayload } from "./StatsTicket.js";
import type { ChannelHost } from "./Terminal.js";

interface Socket {
    readyState: number;
    OPEN: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

interface Hub {
    serverId: number;
    subs: Set<Socket>;
    timer: ReturnType<typeof setTimeout> | undefined;
    stopped: boolean;
    last: Record<string, unknown> | null;
}

interface Session {
    authed: boolean;
    finished: boolean;
    hub: Hub | null;
    authTimer: ReturnType<typeof setTimeout> | undefined;
}

const AUTH_MS = 10_000;
const GAP_MS = 3_000; // pause between one reading finishing and the next starting

const sessions = new WeakMap<Socket, Session>();
const hubs = new Map<number, Hub>();

function send(ws: Socket, message: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(hub: Hub, message: Record<string, unknown>): void {
    hub.last = message;
    for (const ws of hub.subs) send(ws, message);
}

function stopHub(hub: Hub): void {
    hub.stopped = true;
    if (hub.timer) clearTimeout(hub.timer);
    if (hubs.get(hub.serverId) === hub) hubs.delete(hub.serverId);
}

/** Stops a hub and tells everyone on it to go away (server deleted). */
function endHub(hub: Hub, message: string): void {
    const subs = [...hub.subs];
    stopHub(hub);
    for (const ws of subs) {
        const s = sessions.get(ws);
        if (s) finish(ws, s, message);
    }
}

async function tick(hub: Hub): Promise<void> {
    if (hub.stopped) return;

    try {
        const server = (await Server.find(hub.serverId)) as StatsServer | null;
        if (hub.stopped) return;

        if (!server) {
            endHub(hub, "Server not found.");
            return;
        }

        const result = await readStats(server);
        if (hub.stopped) return;

        if (result.ok) broadcast(hub, { t: "stats", d: result.stats });
        else broadcast(hub, { t: "error", m: result.error });
    } catch (error) {
        console.error("[serverstats] poll failed:", error instanceof Error ? error.message : error);
        if (hub.stopped) return;
        broadcast(hub, { t: "error", m: "Couldn't load stats." });
    }

    if (!hub.stopped) hub.timer = setTimeout(() => void tick(hub), GAP_MS);
}

function subscribe(ws: Socket, s: Session, serverId: number): void {
    let hub = hubs.get(serverId);

    if (!hub) {
        hub = { serverId, subs: new Set(), timer: undefined, stopped: false, last: null };
        hubs.set(serverId, hub);
        hub.subs.add(ws);
        s.hub = hub;
        void tick(hub);
        return;
    }

    hub.subs.add(ws);
    s.hub = hub;
    if (hub.last) send(ws, hub.last); // show the latest reading straight away
}

function unsubscribe(ws: Socket, s: Session): void {
    const hub = s.hub;
    if (!hub) return;
    s.hub = null;
    hub.subs.delete(ws);
    if (hub.subs.size === 0) stopHub(hub);
}

function finish(ws: Socket, s: Session, message: string): void {
    if (s.finished) return;
    s.finished = true;

    if (s.authTimer) clearTimeout(s.authTimer);
    unsubscribe(ws, s);

    send(ws, { t: "exit", m: message });
    ws.close();
}

async function begin(ws: Socket, s: Session, ticket: StatsTicketPayload): Promise<void> {
    const userTeam = await teamIdOfRow({ user_id: ticket.u });
    const server = (await Server.find(ticket.v)) as StatsServer | null;
    if (s.finished) return;

    if (!userTeam || !server || (await teamIdOfRow(server)) !== userTeam) {
        finish(ws, s, "Server not found.");
        return;
    }
    if (s.finished) return;

    send(ws, { t: "ready" });
    subscribe(ws, s, server.id);
}

export function registerStats(server: ChannelHost): void {
    server.channel("serverstats", {
        onConnect(ws: Socket) {
            const s: Session = { authed: false, finished: false, hub: null, authTimer: undefined };
            s.authTimer = setTimeout(() => finish(ws, s, "Not authenticated in time."), AUTH_MS);
            sessions.set(ws, s);
        },

        onMessage(ws: Socket, data: unknown) {
            const s = sessions.get(ws);
            if (!s || s.finished || s.authed || typeof data !== "object" || data === null) return;

            const message = data as { t?: unknown; ticket?: unknown };
            if (message.t !== "auth" || typeof message.ticket !== "string") return;

            const ticket = verifyStatsTicket(message.ticket);
            if (!ticket) {
                finish(ws, s, "This link expired.");
                return;
            }

            s.authed = true;
            if (s.authTimer) clearTimeout(s.authTimer);

            begin(ws, s, ticket).catch((error) => {
                console.error("[serverstats] failed to open:", error instanceof Error ? error.message : error);
                finish(ws, s, "Couldn't start live stats.");
            });
        },

        onDisconnect(ws: Socket) {
            const s = sessions.get(ws);
            if (s) finish(ws, s, "Connection closed.");
        },
    });
}