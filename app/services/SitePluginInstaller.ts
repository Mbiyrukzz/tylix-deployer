/**
 * Installs and removes site plugins in the background (same shape as
 * SiteDeployer): SitePluginInstaller.start(siteId, pluginId, "install" | "uninstall").
 *
 * run() never throws. Failures are saved on the site_plugins row.
 * A successful uninstall deletes the row.
 *
 * The server must belong to the same team as the site, like in SiteDeployer.
 */

import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { SitePlugin } from "../models/SitePlugin.js";
import { CryptoService } from "./CryptoService.js";
import { sshExec } from "./Ssh.js";
import { shellScript, serverTarget } from "./Shell.js";
import { envPathFor, type DeployRow } from "./SiteDeployer.js";
import { getPlugin, type PluginSite } from "./SitePlugins.js";
import { teamIdOfRow } from "./TeamScope.js";

type Action = "install" | "uninstall";

interface SiteRow extends PluginSite {
    user_id: number;
    team_id: number | null;
    server_id: number;
    app_directory: string;
    env_content: string;
}

interface ServerRow {
    user_id: number;
    team_id: number | null;
    [key: string]: unknown;
}

interface PluginRow {
    id: number;
    site_id: number;
    plugin: string;
    config: string;
    [key: string]: unknown;
}

const TIMEOUT_MS = 15 * 60_000;
const MAX_LOG = 50_000;

const clip = (text: string) => (text.length > MAX_LOG ? "[... earlier output trimmed ...]\n" + text.slice(-MAX_LOG) : text);

function lastLine(stderr: string, stdout: string): string {
    const clean = (text: string) =>
        text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "" && !l.startsWith("Warning: Permanently added"));

    const err = clean(stderr);
    const lines = err.length > 0 ? err : clean(stdout);
    return (lines[lines.length - 1] ?? "Command failed.").slice(0, 300);
}

export function portOf(row: { config?: unknown } | undefined | null): number {
    try {
        return Number(JSON.parse(String(row?.config || "{}")).port) || 0;
    } catch {
        return 0;
    }
}

function mergeEnv(current: string, incoming: string[]): string {
    const lines = current.replace(/\r\n/g, "\n").split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    for (const line of incoming) {
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        const key = line.slice(0, eq);
        const at = lines.findIndex((l) => l.startsWith(key + "="));
        if (at >= 0) lines[at] = line;
        else lines.push(line);
    }

    return lines.join("\n") + "\n";
}

export class SitePluginInstaller {
    static start(siteId: number, pluginId: string, action: Action): void {
        SitePluginInstaller.run(siteId, pluginId, action).catch((err) => {
            console.error(`Plugin ${action} (${pluginId}) for site ${siteId} crashed:`, err);
        });
    }

    static async run(siteId: number, pluginId: string, action: Action): Promise<void> {
        let log = "";
        let rowId = 0;

        const save = async (patch: Record<string, unknown>) => {
            if (!rowId) return;
            try {
                await SitePlugin.update(rowId, { ...patch, log: clip(log) });
            } catch (err) {
                console.error(`Couldn't save plugin state for site ${siteId}:`, err);
            }
        };

        try {
            const site = (await Site.find(siteId)) as SiteRow | null;
            if (!site) return;

            const def = getPlugin(pluginId);
            if (!def) throw new Error("Unknown plugin.");

            const row = ((await SitePlugin.all()) as PluginRow[]).find(
                (r) => Number(r.site_id) === siteId && r.plugin === pluginId,
            );
            if (!row) throw new Error("The plugin record no longer exists.");
            rowId = row.id;

            const server = (await Server.find(site.server_id)) as ServerRow | null;
            if (!server || (await teamIdOfRow(server)) !== (await teamIdOfRow(site))) {
                throw new Error("The server no longer exists.");
            }
            const target = serverTarget(server as never);

            const port = portOf(row);
            const body = action === "install" ? def.install({ site, port }) : def.uninstall({ site, port });

            const vars: Record<string, string> = {
                SITE_USER: site.isolated_user,
                SITE_ROOT: `/home/${site.isolated_user}/${site.domain}`,
                DOMAIN: site.domain,
                PHP_VERSION: String(site.php_version ?? ""),
                APP_DIR: String(site.app_directory ?? ""),
                PORT: String(port),
                RPC_PORT: String(port ? port + 20000 : 0),
                PLUGIN: def.id,
            };

            log += `==> ${action === "install" ? "Installing" : "Removing"} ${def.name}\n`;
            await save({ step: action });

            const result = await sshExec(target, shellScript(vars, body), TIMEOUT_MS);
            const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
            if (out) log += out + "\n";

            if (result.code !== 0) {
                throw new Error(lastLine(result.stderr, result.stdout));
            }

            if (action === "uninstall") {
                await SitePlugin.delete(row.id);
                return;
            }

            // Keep generated .env keys (Reverb, Octane) alive across deploys: the deployer
            // rewrites .env from the saved env whenever one is saved. The values are
            // never logged because they can contain secrets.
            if (def.envKeys) {
                const fresh = (await Site.find(siteId)) as SiteRow | null;
                const envPath = fresh ? envPathFor(fresh as unknown as DeployRow) : "";

                if (fresh && envPath && fresh.env_content) {
                    const grep = await sshExec(
                        target,
                        shellScript({ ENV_PATH: envPath, KEYS: def.envKeys }, `$SUDO grep -E "$KEYS" "$ENV_PATH" || true`),
                        30_000,
                    );

                    const incoming = String(grep.stdout ?? "")
                        .split("\n")
                        .map((l) => l.trim())
                        .filter(Boolean);

                    if (grep.code === 0 && incoming.length > 0) {
                        const merged = mergeEnv(CryptoService.decrypt(String(fresh.env_content)), incoming);
                        await Site.update(siteId, { env_content: CryptoService.encrypt(merged) });
                        log += "Copied the generated .env keys into the saved Deployment env.\n";
                    }
                }
            }

            log += "Done.\n";
            await save({ status: "installed", step: "", error: "", installed_at: new Date().toISOString() });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Plugin change failed.";
            log += `\nFAILED: ${message}\n`;
            await save({ status: action === "install" ? "failed" : "remove_failed", error: message.slice(0, 500) });
        }
    }
}