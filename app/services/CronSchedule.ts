/**
 * Reads a cron schedule (the syntax CronFiles.checkSchedule accepts: five
 * fields of numbers, *, /, "," and "-", or an @preset) to say in words when it
 * runs and to list its next run times.
 *
 * Cron reads the schedule in the server's local time, so nextRuns takes the
 * server's UTC offset (from `date +%z`). The offset is fixed for the whole
 * window: across a daylight-saving change the times can be an hour out.
 */

const ALIASES: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
};

const BOUNDS: Array<[number, number]> = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 7], // day of week (0 and 7 are Sunday)
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface Parsed {
    minutes: number[];
    hours: number[];
    doms: Set<number>;
    months: Set<number>;
    dows: Set<number>;
    domAny: boolean;
    dowAny: boolean;
}

function parseField(text: string, min: number, max: number): Set<number> | null {
    const out = new Set<number>();
    for (const part of text.split(",")) {
        const [range, stepText] = part.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1) return null;

        let lo: number;
        let hi: number;
        if (range === "*") {
            lo = min;
            hi = max;
        } else if (range.includes("-")) {
            const [a, b] = range.split("-").map(Number);
            lo = a;
            hi = b;
        } else {
            lo = Number(range);
            // "5/15" means from 5 to the end, every 15.
            hi = stepText === undefined ? lo : max;
        }
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
        for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
}

function parse(schedule: string): Parsed | null {
    const expr = ALIASES[schedule] ?? schedule;
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const sets = parts.map((p, i) => parseField(p, BOUNDS[i][0], BOUNDS[i][1]));
    if (sets.some((s) => s === null)) return null;
    const [mi, h, dom, mon, dow] = sets as Set<number>[];
    if (dow.has(7)) dow.add(0);

    return {
        minutes: [...mi].sort((a, b) => a - b),
        hours: [...h].sort((a, b) => a - b),
        doms: dom,
        months: mon,
        dows: dow,
        // Vixie cron: when both day fields are restricted, a day matching EITHER runs.
        domAny: parts[2].startsWith("*"),
        dowAny: parts[4].startsWith("*"),
    };
}

/** "+0300" -> 180, "-0530" -> -330. Anything else is UTC. */
export function offsetMinutes(z: string): number {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(z.trim());
    if (!m) return 0;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === "-" ? -minutes : minutes;
}

/**
 * The next `count` run times (epoch milliseconds) after `nowMs`, for a server
 * `offset` minutes ahead of UTC. Empty for @reboot or a schedule that never
 * matches (31 February).
 */
export function nextRuns(schedule: string, nowMs: number, offset = 0, count = 5): number[] {
    const p = parse(schedule);
    if (!p) return [];

    const shift = offset * 60_000;
    // The first minute that can still run, in server-local time.
    const startLocal = (Math.floor((nowMs + shift) / 60_000) + 1) * 60_000;
    const first = new Date(startLocal);
    const runs: number[] = [];

    // Eight years covers the rarest schedule (29 February on a given weekday).
    for (let day = 0; day < 366 * 8 && runs.length < count; day++) {
        const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() + day));
        if (!p.months.has(d.getUTCMonth() + 1)) continue;

        const domHit = p.doms.has(d.getUTCDate());
        const dowHit = p.dows.has(d.getUTCDay());
        const dayHit = p.domAny || p.dowAny ? domHit && dowHit : domHit || dowHit;
        if (!dayHit) continue;

        for (const h of p.hours) {
            for (const m of p.minutes) {
                const t = d.getTime() + h * 3_600_000 + m * 60_000;
                if (t < startLocal) continue;
                runs.push(t - shift);
                if (runs.length >= count) return runs;
            }
        }
    }
    return runs;
}

const pad = (n: number) => String(n).padStart(2, "0");

function list(names: string[]): string {
    return names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/** The schedule in words where it is a common shape, else "". */
export function describe(schedule: string): string {
    if (schedule === "@reboot") return "When the server starts";
    const expr = ALIASES[schedule] ?? schedule;
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5 || !parse(schedule)) return "";
    const [mi, h, dom, mon, dow] = parts;
    const num = (s: string) => /^\d+$/.test(s);
    const step = (s: string) => (/^\*\/\d+$/.test(s) ? Number(s.slice(2)) : 0);
    const daysOnly = dom === "*" && mon === "*" && dow === "*";

    if (mi === "*" && h === "*" && daysOnly) return "Every minute";
    if (step(mi) && h === "*" && daysOnly) return `Every ${step(mi)} minutes`;
    if (num(mi) && h === "*" && daysOnly) return mi === "0" ? "Every hour, on the hour" : `Every hour at minute ${Number(mi)}`;
    if (num(mi) && step(h) && daysOnly) return `Every ${step(h)} hours at minute ${Number(mi)}`;
    if (!num(mi) || !num(h)) return "";

    const at = `at ${pad(Number(h))}:${pad(Number(mi))}`;
    if (daysOnly) return `Every day ${at}`;
    if (dom === "*" && mon === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
        const names = [...new Set(dow.split(",").map((d) => DAYS[Number(d) % 7]))];
        return `Every ${list(names)} ${at}`;
    }
    if (dom === "*" && mon === "*" && dow === "1-5") return `Every weekday ${at}`;
    if (num(dom) && mon === "*" && dow === "*") return `On day ${Number(dom)} of every month ${at}`;
    if (num(dom) && num(mon) && dow === "*") return `Every year on ${MONTHS[Number(mon) - 1]} ${Number(dom)} ${at}`;
    return "";
}
