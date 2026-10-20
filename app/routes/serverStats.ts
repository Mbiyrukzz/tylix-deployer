/**
 * GET /api/servers/:id/stats
 *
 * Opens one SSH connection and returns CPU, memory, disk, load and uptime.
 * CPU is measured over one second (two /proc/stat samples), so a call takes
 * about two seconds. Any member of the server's team may read it; another
 * team's server answers 404. Answers 502 when the server can't be reached.
 */

import type { Router } from "@tylix/core";
import { Server } from "../models/Server.js";
import { CryptoService } from "../services/CryptoService.js";
import { sshExec } from "../services/Ssh.js";
import { requireTeam } from "../services/TeamScope.js";

type Handler = Parameters<Router["get"]>[1];

const COMMAND = [
    "head -n1 /proc/stat",
    "sleep 1",
    "head -n1 /proc/stat",
    "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
    "df -B1 / | tail -n1",
    "cat /proc/loadavg",
    "cat /proc/uptime",
].join("; ");

function readCpu(line: string): { total: number; idle: number } {
    const n = line.trim().split(/\s+/).slice(1, 9).map(Number);
    return {
        total: n.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0),
        idle: (n[3] || 0) + (n[4] || 0),
    };
}

function parseStats(stdout: string) {
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 7) throw new Error("Unexpected output from the server.");

    const a = readCpu(lines[0]);
    const b = readCpu(lines[1]);
    const totalDelta = b.total - a.total;
    const idleDelta = b.idle - a.idle;
    const cpu = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;

    const kb = (label: string) => {
        const m = lines.find((l) => l.startsWith(label + ":"))?.match(/(\d+)/);
        return m ? Number(m[1]) * 1024 : 0;
    };
    const memTotal = kb("MemTotal");
    const memAvail = kb("MemAvailable");
    const memUsed = Math.max(0, memTotal - memAvail);

    const df = lines[lines.length - 3].split(/\s+/);
    const diskTotal = Number(df[1]) || 0;
    const diskUsed = Number(df[2]) || 0;

    const load = lines[lines.length - 2].split(/\s+/).slice(0, 3).map(Number);
    const uptime = Number(lines[lines.length - 1].split(/\s+/)[0]) || 0;

    return {
        cpu_pct: Math.round(cpu * 10) / 10,
        mem_used: memUsed,
        mem_total: memTotal,
        mem_pct: memTotal > 0 ? Math.round((memUsed / memTotal) * 1000) / 10 : 0,
        disk_used: diskUsed,
        disk_total: diskTotal,
        disk_pct: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 1000) / 10 : 0,
        load,
        uptime,
    };
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/servers/:id/stats",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const server = (await Server.find(req.params.id)) as
                | { id: number; user_id: number; team_id: number | null; host: string; port: number; ssh_user: string; ssh_key: string; status: string }
                | null;

            if (!server || Number(server.team_id) !== teamId) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            const result = await sshExec(
                {
                    host: server.host,
                    port: Number(server.port),
                    user: server.ssh_user,
                    privateKey: CryptoService.decrypt(server.ssh_key),
                },
                COMMAND,
                20_000,
            );

            if (result.code !== 0) {
                if (server.status !== "offline") await Server.update(server.id, { status: "offline" });
                res.status(502);
                return res.json({ error: "Couldn't reach the server over SSH." });
            }

            try {
                const stats = parseStats(result.stdout);
                if (server.status !== "online") await Server.update(server.id, { status: "online" });
                return res.json({ ...stats, status: "online" });
            } catch {
                res.status(502);
                return res.json({ error: "The server answered, but the stats couldn't be read." });
            }
        }),
    );
}
