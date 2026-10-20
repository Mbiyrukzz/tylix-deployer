/**
 * Reads CPU, memory, disk, load and uptime from a server over one SSH
 * connection. CPU is measured over one second (two /proc/stat samples), so a
 * call takes about two seconds. Shared by GET /api/servers/:id/stats and the
 * "serverstats" channel.
 */

import { Server } from "../models/Server.js";
import { CryptoService } from "./CryptoService.js";
import { sshExec } from "./Ssh.js";

export interface StatsServer {
    id: number;
    user_id: number;
    team_id: number | null;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
    status: string;
}

export interface Stats {
    cpu_pct: number;
    mem_used: number;
    mem_total: number;
    mem_pct: number;
    disk_used: number;
    disk_total: number;
    disk_pct: number;
    load: number[];
    uptime: number;
}

export type StatsResult = { ok: true; stats: Stats } | { ok: false; error: string };

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

function parseStats(stdout: string): Stats {
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

async function setStatus(server: StatsServer, status: string): Promise<void> {
    if (server.status === status) return;
    await Server.update(server.id, { status });
    server.status = status;
}

export async function readStats(server: StatsServer): Promise<StatsResult> {
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
        await setStatus(server, "offline");
        return { ok: false, error: "Couldn't reach the server over SSH." };
    }

    try {
        const stats = parseStats(result.stdout);
        await setStatus(server, "online");
        return { ok: true, stats };
    } catch {
        return { ok: false, error: "The server answered, but the stats couldn't be read." };
    }
}