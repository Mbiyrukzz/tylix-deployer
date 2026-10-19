/**
 * Runs one-off commands on a site's server over SSH, for the Commands page.
 *
 * Commands run as the site's isolated user (never root), in the site folder
 * (or a folder inside it), through a login shell so node/nvm are on the PATH.
 * The command travels to the server base64-encoded, so nothing in it can
 * break out of the wrapper script.
 *
 * Runs are kept in memory (last 20 per site), so history is cleared when the
 * app restarts.
 */

import { randomUUID } from "node:crypto";
import { Server } from "../models/Server.js";
import { sshExec } from "./Ssh.js";
import { shellScript, serverTarget } from "./Shell.js";

export interface CommandSite {
    id: number;
    server_id: number;
    domain: string;
    isolated_user: string;
    [key: string]: unknown;
}

export interface CommandRun {
    id: string;
    site_id: number;
    user_id: number;
    command: string;
    directory: string;
    status: "running" | "success" | "failed";
    code: number | null;
    output: string;
    started_at: string;
    finished_at: string;
}

export const MAX_COMMAND_CHARS = 2000;

const LIMIT_SECONDS = 600;
const SSH_TIMEOUT_MS = (LIMIT_SECONDS + 60) * 1000;
const MAX_OUTPUT = 100_000;
const KEEP_PER_SITE = 20;
const STALE_MS = 15 * 60_000;

const runs = new Map<number, CommandRun[]>();

const clip = (text: string) =>
    text.length > MAX_OUTPUT ? "[... earlier output trimmed ...]\n" + text.slice(-MAX_OUTPUT) : text;

const SCRIPT = `
WORK="$SITE_ROOT"
if [ -n "$RUN_DIR" ]; then WORK="$SITE_ROOT/$RUN_DIR"; fi
if [ ! -d "$WORK" ]; then echo "The folder $WORK does not exist."; exit 66; fi
CMD="$(printf '%s' "$CMD_B64" | base64 -d)"
set +e
as_user timeout "$LIMIT" bash -lc "cd '$WORK' && $CMD" 2>&1
CODE=$?
if [ "$CODE" -eq 124 ]; then
  echo
  echo "Stopped: the command ran for more than $((LIMIT / 60)) minutes."
fi
exit "$CODE"`;

export const SiteCommands = {
    /** Newest first. */
    list(siteId: number): CommandRun[] {
        return [...(runs.get(siteId) ?? [])].reverse();
    },

    isBusy(siteId: number): boolean {
        return (runs.get(siteId) ?? []).some(
            (r) => r.status === "running" && Date.now() - new Date(r.started_at).getTime() < STALE_MS,
        );
    },

    start(site: CommandSite, userId: number, command: string, directory: string): CommandRun {
        const run: CommandRun = {
            id: randomUUID(),
            site_id: site.id,
            user_id: userId,
            command,
            directory,
            status: "running",
            code: null,
            output: "",
            started_at: new Date().toISOString(),
            finished_at: "",
        };

        const list = runs.get(site.id) ?? [];
        list.push(run);
        while (list.length > KEEP_PER_SITE) list.shift();
        runs.set(site.id, list);

        SiteCommands.execute(site, run).catch((err) => {
            console.error(`Command run for site ${site.id} crashed:`, err);
        });

        return run;
    },

    async execute(site: CommandSite, run: CommandRun): Promise<void> {
        const finish = (code: number, output: string) => {
            run.code = code;
            run.output = clip(output);
            run.status = code === 0 ? "success" : "failed";
            run.finished_at = new Date().toISOString();
        };

        try {
            const server = await Server.find(site.server_id);
            if (!server) throw new Error("The server no longer exists.");
            const target = serverTarget(server as never);

            const script = shellScript(
                {
                    DOMAIN: site.domain,
                    SITE_USER: site.isolated_user,
                    SITE_ROOT: `/home/${site.isolated_user}/${site.domain}`,
                    RUN_DIR: run.directory,
                    CMD_B64: Buffer.from(run.command, "utf8").toString("base64"),
                    LIMIT: String(LIMIT_SECONDS),
                },
                SCRIPT,
            );

            const result = await sshExec(target, script, SSH_TIMEOUT_MS);
            finish(Number(result.code ?? 1), String(result.stdout ?? ""));
        } catch (err) {
            finish(1, err instanceof Error ? err.message : "The command could not be run.");
        }
    },
};