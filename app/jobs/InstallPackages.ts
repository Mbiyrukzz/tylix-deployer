/**
 * Job: InstallPackages
 *
 * Installs packages from the catalog (services/Installers.ts) on an existing
 * server over SSH. Re-runnable: installers skip finished components.
 * Progress is written to the server_tasks row, one step at a time: the step's
 * label, step_no of step_total, and the output so far (log).
 *
 * A task only ends "done" when every package it asked for is found on the
 * server afterwards. Anything else ends "failed" with the reason in error:
 * the failing step's error line (with a hint for common causes), a package
 * that installed but isn't detected, or an unexpected crash.
 *
 * TEAMS: the task and its server must belong to the same team. Rows saved
 * before every create path stamped team_id fall back to the creator's team
 * (teamIdOfRow).
 */

import { ServerTask } from "../models/ServerTask.js";
import { Server } from "../models/Server.js";
import { CryptoService } from "../services/CryptoService.js";
import {
    PACKAGES,
    UPGRADE_ID,
    stepsForPackages,
    runInstallStep,
    detectInstalled,
    clearMarkers,
    stepIdFor,
} from "../services/Installers.js";
import { teamIdOfRow } from "../services/TeamScope.js";

interface TaskRow {
    id: number;
    user_id: number;
    team_id?: number | null;
    server_id: number;
    packages: string;
    step: string;
    status: string;
    error: string;
    [key: string]: unknown;
}

interface ServerRow {
    id: number;
    user_id: number;
    team_id: number | null;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
    [key: string]: unknown;
}

// What the task keeps of the output: enough to scroll back through a failed
// apt run without growing the row without limit.
const LOG_MAX = 60_000;
// How often the streamed output is written to the row while a step runs.
const FLUSH_MS = 2_000;

/** Keeps the last `max` characters, starting on a whole line. */
function keepTail(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(-max);
    const nl = cut.indexOf("\n");
    return "…(earlier output trimmed)\n" + (nl >= 0 ? cut.slice(nl + 1) : cut);
}

/** Removes terminal colour codes and carriage-return progress redraws. */
function clean(chunk: string): string {
    return chunk
        .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
        .replace(/[^\n]*\r(?!\n)/g, "");
}

async function save(id: number, patch: Record<string, unknown>): Promise<void> {
    await ServerTask.update(id, patch);
}

/**
 * Records the failure. This must not be lost: if the full patch is refused
 * (an old, narrower column), the status alone is saved, so the task never
 * looks like it is still running.
 */
async function fail(id: number, error: string, log?: string): Promise<void> {
    const patch: Record<string, unknown> = { status: "failed", error: error.slice(0, 2000) };
    if (log !== undefined) patch.log = keepTail(log, LOG_MAX);
    try {
        await save(id, patch);
        return;
    } catch (err) {
        console.error(`[InstallPackages] task ${id}: couldn't save the failure`, err);
    }
    try {
        await save(id, { status: "failed", error: error.slice(0, 250) });
    } catch (err) {
        console.error(`[InstallPackages] task ${id}: couldn't mark it failed`, err);
    }
}

export const InstallPackages = {
    async handle(payload: { taskId: number | string; [key: string]: unknown }) {
        const id = Number(payload.taskId);
        const task = (await ServerTask.find(id)) as TaskRow | null;
        if (!task) throw new Error(`Task ${id} not found.`);
        if (task.status === "done" || task.status === "failed") return;

        let log = "";
        let dirty = false;
        let flushing: Promise<void> | null = null;
        let lastFlush = 0;

        const flush = async (force = false) => {
            if (!dirty || (!force && Date.now() - lastFlush < FLUSH_MS)) return;
            if (flushing) {
                await flushing;
                if (!force) return;
            }
            dirty = false;
            lastFlush = Date.now();
            flushing = save(id, { log: keepTail(log, LOG_MAX) })
                .catch((err) => console.error(`[InstallPackages] task ${id}: couldn't save the log`, err))
                .finally(() => {
                    flushing = null;
                });
            await flushing;
        };

        const write = (text: string) => {
            log += text;
            if (log.length > LOG_MAX * 2) log = keepTail(log, LOG_MAX);
            dirty = true;
            void flush();
        };

        try {
            const server = (await Server.find(task.server_id)) as ServerRow | null;
            if (!server || (await teamIdOfRow(server)) !== (await teamIdOfRow(task))) {
                throw new Error("That server no longer exists.");
            }

            const ids = JSON.parse(task.packages) as string[];
            const upgrading = ids.includes(UPGRADE_ID);
            const wanted = ids.filter((p) => p !== UPGRADE_ID);
            const steps = stepsForPackages(ids);

            const target = {
                host: server.host,
                port: Number(server.port),
                user: server.ssh_user,
                privateKey: CryptoService.decrypt(server.ssh_key),
            };

            await save(id, { status: "running", error: "", log: "", step: "Connecting", step_no: 0, step_total: steps.length });

            // A package that is missing although its marker says it was installed
            // (removed by hand, or an install that once ended early) must really
            // run again, or the task would "finish" without installing anything.
            if (wanted.length > 0) {
                write(`$ checking what is already on ${server.host}\n`);
                const present = await detectInstalled(target);
                const stale = wanted
                    .filter((p) => !present.includes(p))
                    .map((p) => stepIdFor(p))
                    .filter((s): s is string => Boolean(s));
                if (stale.length > 0) await clearMarkers(target, stale);
                const already = wanted.filter((p) => present.includes(p));
                if (already.length > 0) write(`Already installed: ${already.join(", ")}\n`);
            }

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                await flush(true);
                await save(id, { step: step.label, step_no: i + 1 });
                write(`\n==> [${i + 1}/${steps.length}] ${step.label}\n`);

                const result = await runInstallStep(target, step, (chunk) => write(clean(chunk)));
                if (!result.ok) {
                    write(`\n✕ ${step.label} failed.\n`);
                    await flush(true);
                    await fail(id, `${step.label} failed: ${result.reason}`, log);
                    return;
                }
                write(`✓ ${step.label}\n`);
            }

            // Done only when the server now reports every package that was asked for.
            if (wanted.length > 0) {
                await save(id, { step: "Checking the result" });
                const present = await detectInstalled(target);
                const missing = wanted.filter((p) => !present.includes(p));
                if (missing.length > 0) {
                    const names = missing.map((p) => PACKAGES.find((d) => d.id === p)?.label ?? p).join(", ");
                    write(`\n✕ Not found on the server after installing: ${names}\n`);
                    await flush(true);
                    await fail(
                        id,
                        `Every step finished, but the server still doesn't report ${names} as installed. ` +
                            "Open the output below for details, or run the install again.",
                        log,
                    );
                    return;
                }
            }

            write(upgrading ? "\n✓ Packages updated.\n" : `\n✓ Installed: ${wanted.join(", ")}\n`);
            await flush(true);
            await save(id, { step: "Finished", status: "done", error: "", step_no: steps.length });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            write(`\n✕ ${message}\n`);
            await flush(true).catch(() => {});
            await fail(id, message, log);
            throw error;
        }
    },
};
