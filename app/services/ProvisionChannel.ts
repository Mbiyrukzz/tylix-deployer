/**
 * Live provisioning progress on the Tylix channel server ("provisionprogress").
 *
 * Protocol (JSON both ways):
 *   browser -> server  { t: "auth", ticket }      must be the first message
 *   server  -> browser { t: "ready" }             ticket accepted
 *                      { t: "progress", d: {...} } sent when something changes
 *                      { t: "exit", m: "..." }    then the socket closes
 *
 * The job runs in the queue worker, so this reads the provision row every
 * POLL_MS. One poller runs per provision however many browsers watch it.
 * It stops with the last viewer, or when the provision is done.
 */

import { Provision } from "../models/Provision.js";
import { teamIdOfRow } from "./TeamScope.js";
import { verifyProvisionTicket } from "./ProvisionTicket.js";
import type { ProvisionTicketPayload } from "./ProvisionTicket.js";
import { progressOf } from "./ProvisionProgress.js";
import type { ProvisionRow } from "./ProvisionProgress.js";
import type { ChannelHost } from "./Terminal.js";

interface Socket {
    readyState: number;
    OPEN: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

interface Hub {
    provisionId: number;
    subs: Set<Socket>;
    timer: ReturnType<typeof setTimeout> | undefined;
    stopped: boolean;
    last: string | null;
}

interface Session {
    authed: boolean;
    finished: boolean;
    hub: Hub | null;
    authTimer: ReturnType<typeof setTimeout> | undefined;
}

const AUTH_MS = 10_000;
const POLL_MS = 2_000;

const sessions = new WeakMap<Socket, Session>();
const hubs = new Map<number, Hub>();

function send(ws: Socket, message: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function stopHub(hub: Hub): void {
    hub.stopped = true;
    if (hub.timer) clearTimeout(hub.timer);
    if (hubs.get(hub.provisionId) === hub) hubs.delete(hub.provisionId);
}

/** Stops a hub and tells everyone on it to go away. */
function endHub(hub: Hub, message: string): void {
    const subs = [...hub.subs];
    stopHub(hub);
    subs.forEach((ws) => {
        const s = sessions.get(ws);
        if (s) finish(ws, s, message);
    });
}

async function tick(hub: Hub): Promise<void> {
    if (hub.stopped) return;

    try {
        const row = (await Provision.find(hub.provisionId)) as ProvisionRow | null;
        if (hub.stopped) return;

        if (!row) {
            endHub(hub, "Provision not found.");
            return;
        }

        const progress = progressOf(row);
        const payload = JSON.stringify({ t: "progress", d: progress });

        if (payload !== hub.last) {
            hub.last = payload;
            hub.subs.forEach((ws) => send(ws, { t: "progress", d: progress }));
        }

        if (progress.status === "done") {
            endHub(hub, "Finished.");
            return;
        }
    } catch (error) {
        console.error("[provisionprogress] poll failed:", error instanceof Error ? error.message : error);
        if (hub.stopped) return;
    }

    if (!hub.stopped) hub.timer = setTimeout(() => void tick(hub), POLL_MS);
}

function subscribe(ws: Socket, s: Session, provisionId: number): void {
    const existing = hubs.get(provisionId);

    if (!existing) {
        const hub: Hub = { provisionId, subs: new Set([ws]), timer: undefined, stopped: false, last: null };
        hubs.set(provisionId, hub);
        s.hub = hub;
        void tick(hub);
        return;
    }

    existing.subs.add(ws);
    s.hub = existing;
    if (existing.last) ws.send(existing.last); // latest reading straight away
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

async function begin(ws: Socket, s: Session, ticket: ProvisionTicketPayload): Promise<void> {
    const userTeam = await teamIdOfRow({ user_id: ticket.u });
    const row = (await Provision.find(ticket.p)) as ProvisionRow | null;
    if (s.finished) return;

    if (!userTeam || !row || (await teamIdOfRow(row)) !== userTeam) {
        finish(ws, s, "Provision not found.");
        return;
    }
    if (s.finished) return;

    send(ws, { t: "ready" });
    subscribe(ws, s, row.id);
}

export function registerProvision(server: ChannelHost): void {
    server.channel("provisionprogress", {
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

            const ticket = verifyProvisionTicket(message.ticket);
            if (!ticket) {
                finish(ws, s, "This link expired.");
                return;
            }

            s.authed = true;
            if (s.authTimer) clearTimeout(s.authTimer);

            begin(ws, s, ticket).catch((error) => {
                console.error("[provisionprogress] failed to open:", error instanceof Error ? error.message : error);
                finish(ws, s, "Couldn't start live progress.");
            });
        },

        onDisconnect(ws: Socket) {
            const s = sessions.get(ws);
            if (s) finish(ws, s, "Connection closed.");
        },
    });
}