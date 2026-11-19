/**
 * Team-wide deployment insights for the Overview page.
 *
 * GET /api/insights/deployments?range=daily|weekly|monthly
 *
 *   daily    the last 14 days, one bucket per day
 *   weekly   the last 12 weeks, one bucket per ISO week (Monday start)
 *   monthly  the last 12 months, one bucket per month
 *
 * Answers:
 *   {
 *     range, buckets: [{ key, label, total, success, failed }],
 *     total, previous_total, success_rate,   // this window vs the one before
 *     in_progress,                            // queued or deploying right now
 *     recent: [{ id, site_id, domain, status, branch, commit, commit_message,
 *                started_at, finished_at, created_at, duration_seconds }]
 *   }
 *
 * Team-scoped: only deployments of sites on the caller's team. Any member
 * can read it (it is the same information the per-site history shows; logs
 * and who deployed are never included).
 */

import type { Router } from "@tylix/core";
import { Site } from "../models/Site.js";
import { Deployment } from "../models/Deployment.js";
import { requireTeam } from "../services/TeamScope.js";

type Handler = Parameters<Router["get"]>[1];
type Range = "daily" | "weekly" | "monthly";

interface SiteRow {
    id: number;
    team_id: number | null;
    domain: string;
}

interface DeploymentRow {
    id: number;
    site_id: number;
    status: string;
    branch: string;
    commit_sha: string;
    commit_message: string;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
}

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function rangeOf(req: unknown): Range {
    const v = (req as { query?: Record<string, unknown> }).query?.range;
    return v === "daily" || v === "monthly" ? v : "weekly";
}

function startOfDay(t: number): number {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfWeek(t: number): number {
    const day = startOfDay(t);
    const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
    return day - dow * DAY;
}

function startOfMonth(t: number): number {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function addMonths(t: number, n: number): number {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}

/** ISO week number of a UTC timestamp. */
function isoWeek(t: number): number {
    const d = new Date(t);
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
    return Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
}

interface Bucket {
    key: string;
    label: string;
    from: number;
    to: number;
    total: number;
    success: number;
    failed: number;
}

/** The window's buckets, oldest first, plus where the previous window starts. */
function bucketsFor(range: Range, now: number): { buckets: Bucket[]; previousFrom: number } {
    const buckets: Bucket[] = [];
    if (range === "daily") {
        const today = startOfDay(now);
        for (let i = 13; i >= 0; i--) {
            const from = today - i * DAY;
            const d = new Date(from);
            buckets.push({ key: new Date(from).toISOString().slice(0, 10), label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, from, to: from + DAY, total: 0, success: 0, failed: 0 });
        }
        return { buckets, previousFrom: buckets[0].from - 14 * DAY };
    }
    if (range === "monthly") {
        const month = startOfMonth(now);
        for (let i = 11; i >= 0; i--) {
            const from = addMonths(month, -i);
            const d = new Date(from);
            buckets.push({ key: new Date(from).toISOString().slice(0, 7), label: MONTHS[d.getUTCMonth()], from, to: addMonths(from, 1), total: 0, success: 0, failed: 0 });
        }
        return { buckets, previousFrom: addMonths(buckets[0].from, -12) };
    }
    const week = startOfWeek(now);
    for (let i = 11; i >= 0; i--) {
        const from = week - i * 7 * DAY;
        buckets.push({ key: new Date(from).toISOString().slice(0, 10), label: `W${isoWeek(from)}`, from, to: from + 7 * DAY, total: 0, success: 0, failed: 0 });
    }
    return { buckets, previousFrom: buckets[0].from - 12 * 7 * DAY };
}

function timeOf(value: unknown): number {
    if (!value) return NaN;
    const t = new Date(String(value).includes("T") ? String(value) : String(value).replace(" ", "T") + "Z").getTime();
    return t;
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/insights/deployments",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const range = rangeOf(req);
            const now = Date.now();
            const { buckets, previousFrom } = bucketsFor(range, now);

            const sites = ((await Site.all()) as unknown as SiteRow[]).filter((s) => Number(s.team_id) === teamId);
            const domainOf = new Map(sites.map((s) => [Number(s.id), String(s.domain ?? "")]));
            const siteIds = sites.map((s) => Number(s.id));

            let rows: DeploymentRow[] = [];
            if (siteIds.length > 0) {
                rows = (await (Deployment as any).whereIn("site_id", siteIds).get()) as DeploymentRow[];
            }

            let previousTotal = 0;
            let windowSuccess = 0;
            let windowFinished = 0;
            let inProgress = 0;

            for (const row of rows) {
                if (row.status === "queued" || row.status === "deploying") inProgress++;
                const t = timeOf(row.created_at);
                if (!Number.isFinite(t)) continue;
                if (t >= previousFrom && t < buckets[0].from) {
                    previousTotal++;
                    continue;
                }
                const bucket = buckets.find((b) => t >= b.from && t < b.to);
                if (!bucket) continue;
                bucket.total++;
                if (row.status === "success") {
                    bucket.success++;
                    windowSuccess++;
                    windowFinished++;
                } else if (row.status === "failed") {
                    bucket.failed++;
                    windowFinished++;
                }
            }

            const total = buckets.reduce((n, b) => n + b.total, 0);

            const recent = rows
                .slice()
                .sort((a, b) => Number(b.id) - Number(a.id))
                .slice(0, 8)
                .map((d) => {
                    const started = timeOf(d.started_at);
                    const finished = timeOf(d.finished_at);
                    return {
                        id: d.id,
                        site_id: d.site_id,
                        domain: domainOf.get(Number(d.site_id)) ?? "",
                        status: d.status,
                        branch: String(d.branch ?? ""),
                        commit: String(d.commit_sha ?? "").slice(0, 7),
                        commit_message: String(d.commit_message ?? "").split("\n")[0].slice(0, 140),
                        started_at: d.started_at,
                        finished_at: d.finished_at,
                        created_at: d.created_at,
                        duration_seconds: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, Math.round((finished - started) / 1000)) : null,
                    };
                });

            return res.json({
                range,
                buckets: buckets.map(({ key, label, total, success, failed }) => ({ key, label, total, success, failed })),
                total,
                previous_total: previousTotal,
                success_rate: windowFinished > 0 ? Math.round((windowSuccess / windowFinished) * 1000) / 10 : null,
                in_progress: inProgress,
                recent,
            });
        }),
    );
}
