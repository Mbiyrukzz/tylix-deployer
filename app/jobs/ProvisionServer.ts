/**
 * Job: ProvisionServer
 *
 * Creates a machine at the provider, waits for SSH, installs the template's
 * components, then adds it to the Servers list. Run by `npx tylix queue:work`,
 * which has no timeout, no retry and no crash recovery, so this job is written
 * to be re-runnable:
 *
 *   - the keypair is saved (encrypted) before anything is created
 *   - the instance is tagged or labelled tylix-provision-<id>; a re-run adopts
 *     it instead of creating a second billable machine
 *   - instance_ref is saved the moment the provider accepts the create call
 *   - installers leave marker files on the server, so a re-run skips finished
 *     components (see services/Installers.ts)
 *   - every failure is written to the provision row (never including credentials)
 *
 * PROVISION_DRY_RUN=1 runs every check except the create call.
 *
 * All provider-specific work goes through ProviderAdapter, so this file has no
 * provider-specific code in it.
 *
 * TEAMS: the provision, its provider connection and the server it creates
 * must all belong to the same team. If the provision has no team_id yet, the
 * job works it out (teamIdOfRow) and saves it. The server it creates gets the
 * provision's team_id, so every teammate sees it.
 *
 * LOGS: every milestone is written to the server log with provision_id set.
 * Once the server record exists, attachProvision() links the whole creation
 * history to it. Passwords, keys and tokens are never logged.
 */

import { Provision } from "../models/Provision.js";
import { Provider } from "../models/Provider.js";
import { Server } from "../models/Server.js";
import { CryptoService } from "../services/CryptoService.js";
// REF: instanceRefOf is new in this import. AWS: providerSecret reads api_token or credentials.
import { adapterFor, instanceRefOf, providerSecret, type ProviderAdapter } from "../services/ProviderAdapter.js";
import { generateKeyPair, derivePublicKey, sshExec } from "../services/Ssh.js";
import { installStepsFor, runInstallStep } from "../services/Installers.js";
import { ServerLogService, type LogLevel } from "../services/ServerLogService.js";
import { syncFirewall } from "../services/FirewallSync.js";
import { teamIdOfRow } from "../services/TeamScope.js";

const BOOT_TIMEOUT_MS = 6 * 60 * 1000;
const BOOT_POLL_MS = 5_000;
const SSH_TIMEOUT_MS = 6 * 60 * 1000;
const SSH_POLL_MS = 10_000;

interface ProvisionRow {
    id: number;
    user_id: number;
    team_id: number | null;
    provider_id: number;
    name: string;
    region: string;
    plan: string;
    image: string;
    template: string;
    step: string;
    status: string;
    instance_id: number;
    instance_ref: string; // REF: new column
    ip: string;
    error: string;
    ssh_key: string;
    server_id: number;
    root_password: string;
    [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function load(id: number): Promise<ProvisionRow> {
    const row = (await Provision.find(id)) as ProvisionRow | null;
    if (!row) throw new Error(`Provision ${id} not found.`);
    return row;
}

async function save(id: number, patch: Record<string, unknown>): Promise<void> {
    await Provision.update(id, patch);
}

/** Writes one event for this provision. Never throws (ServerLogService.record is safe). */
function log(
    row: ProvisionRow,
    event: string,
    message: string,
    level: LogLevel = "info",
    meta?: Record<string, unknown>,
) {
    return ServerLogService.record({
        userId: row.user_id,
        teamId: Number(row.team_id) || null,
        provisionId: row.id,
        serverId: Number(row.server_id) || null,
        event,
        level,
        message,
        meta,
    });
}

// REF: takes the string reference instead of a number.
async function waitForRunning(adapter: ProviderAdapter, ref: string): Promise<string> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;

    while (Date.now() < deadline) {
        try {
            const instance = await adapter.get(ref);
            if (instance.status === "running" && instance.ip) {
                return instance.ip;
            }
        } catch (error) {
            // Network blips, 5xx and rate limits: keep polling. Anything else is real.
            if (!adapter.isTransient(error)) throw error;
        }
        await sleep(BOOT_POLL_MS);
    }

    throw new Error("The server didn't finish booting in time.");
}

async function waitForSsh(host: string, privateKey: string): Promise<void> {
    const deadline = Date.now() + SSH_TIMEOUT_MS;
    let last = "";

    while (Date.now() < deadline) {
        const result = await sshExec({ host, port: 22, user: "root", privateKey }, "true", 20_000);
        if (result.code === 0) return;

        last = result.stderr.trim().split("\n").pop() ?? "";
        await sleep(SSH_POLL_MS);
    }

    throw new Error("SSH didn't become reachable in time." + (last ? ` Last error: ${last}` : ""));
}

export const ProvisionServer = {
    async handle(payload: { provisionId: number | string; [key: string]: unknown }) {
        const id = Number(payload.provisionId);
        const dryRun = process.env.PROVISION_DRY_RUN === "1";

        let row = await load(id);
        if (row.status === "done") return;

        // Declared out here so the catch block can use it to word errors.
        let adapter: ProviderAdapter | null = null;

        try {
            const provider = (await Provider.find(row.provider_id)) as
                | { user_id: number; team_id?: number | null; kind: string; api_token: string; credentials: string }
                | null;

            if (!provider) {
                throw new Error("The provider connection no longer exists.");
            }

            // The provision and its provider connection must belong to the same team.
            // Rows saved before every create path stamped team_id fall back to the
            // creator's team (teamIdOfRow).
            const teamId = await teamIdOfRow(row);
            const providerTeamId = await teamIdOfRow(provider);

            if (!teamId || teamId !== providerTeamId) {
                throw new Error("The provider connection no longer exists.");
            }

            if (Number(row.team_id) !== teamId) {
                await save(id, { team_id: teamId });
                row = await load(id);
            }

            adapter = adapterFor(provider.kind, providerSecret(provider));

            if (dryRun) {
                await adapter.verify();
                await generateKeyPair(`dry-run-${id}`);
                await save(id, { step: "dry_run_ok", status: "dry_run", error: "" });
                await log(row, "provision.dry_run_ok", "Dry run passed. Nothing was created.", "info", {
                    provider: provider.kind,
                });
                return;
            }

            // A saved step or instance means an earlier run got somewhere: this is a resume.
            // REF: instanceRefOf also understands rows made before instance_ref existed.
            const resuming = Boolean(row.step) || instanceRefOf(row) !== "";
            await save(id, { status: "running", error: "" });
            await log(
                row,
                resuming ? "provision.resumed" : "provision.started",
                resuming
                    ? `Provisioning of "${row.name}" resumed from step "${row.step || "start"}".`
                    : `Provisioning of "${row.name}" started.`,
                "info",
                {
                    provider: provider.kind,
                    region: row.region,
                    plan: row.plan,
                    image: row.image,
                    template: row.template,
                },
            );

            // 1. Keypair: saved before anything billable exists.
            if (!row.ssh_key) {
                const pair = await generateKeyPair(`tylix-deploy-${id}`);
                await save(id, { ssh_key: CryptoService.encrypt(pair.privateKey) });
                row = await load(id);
                await log(row, "provision.keypair_created", "Deploy keypair generated and stored encrypted.");
            }
            const privateKey = CryptoService.decrypt(row.ssh_key);

            // The root password has two sources.
            //   Linode:  we generate it here and save it before creating.
            //   Others:  the provider generates it (Hetzner) or never exposes it
            //            (DigitalOcean, Vultr, AWS), so presetRootPassword() is null and
            //            any password is saved in step 2, right after create.
            if (!row.root_password) {
                const preset = adapter.presetRootPassword();
                if (preset) {
                    await save(id, { root_password: CryptoService.encrypt(preset) });
                    row = await load(id);
                }
            }
            const rootPassword = row.root_password ? CryptoService.decrypt(row.root_password) : null;

            // 2. Create (or adopt) the instance.
            // REF: "no machine yet" is now "no reference", not "instance_id is 0".
            if (!instanceRefOf(row)) {
                await save(id, { step: "creating" });

                // The adapter knows how to recognise our own machine and refuses
                // to adopt anyone else's. AWS: the region is needed, EC2 searches one region at a time.
                let instance = await adapter.findOurs(id, row.name, row.region);
                let providerPassword: string | null = null;
                let adopted = true;

                if (!instance) {
                    adopted = false;
                    const created = await adapter.create({
                        provisionId: id,
                        name: row.name,
                        region: row.region,
                        plan: row.plan,
                        image: row.image,
                        rootPassword,
                        publicKey: await derivePublicKey(privateKey),
                    });
                    instance = created.instance;
                    providerPassword = created.rootPassword;
                }

                // The reference is saved the moment the provider accepts the create.
                // For Hetzner the password rides in the SAME write: it is only ever
                // returned once, so it must never wait for a later save.
                const patch: Record<string, unknown> = {
                    // REF: the string reference is the source of truth now.
                    instance_ref: instance.ref,
                    // Keep the old numeric column filled when the id is numeric,
                    // for any code that still reads it. UUIDs and AWS refs leave it at 0.
                    instance_id: /^\d+$/.test(instance.ref) ? Number(instance.ref) : 0,
                    step: "booting",
                };
                if (providerPassword && !row.root_password) {
                    patch.root_password = CryptoService.encrypt(providerPassword);
                }
                await save(id, patch);
                row = await load(id);

                await log(
                    row,
                    adopted ? "provision.instance_adopted" : "provision.instance_created",
                    adopted
                        ? "Found the machine from an earlier attempt and reused it."
                        : "The provider accepted the create request.",
                    "success",
                    // REF: logged as instance_ref
                    { provider: provider.kind, instance_ref: instance.ref },
                );
            }

            // 3. Wait for it to boot and get its address.
            if (!row.ip) {
                await save(id, { step: "booting" });
                // REF: pass the string reference
                const ip = await waitForRunning(adapter, instanceRefOf(row));
                await save(id, { ip, step: "waiting_ssh" });
                row = await load(id);
                await log(row, "provision.booted", `The machine is running at ${ip}.`, "success", { ip });
            }

            // 4. Wait until we can log in with our key. Instant when it is already up.
            await save(id, { step: "waiting_ssh" });
            await waitForSsh(row.ip, privateKey);
            await log(row, "provision.ssh_ready", "SSH is reachable with the deploy key.", "success");

            // 5. Install the template's components, one step at a time.
            // Each step is its own row step, so updated_at moves and the sweep
            // never mistakes a healthy install for a dead one.
            const target = { host: row.ip, port: 22, user: "root", privateKey };
            for (const step of installStepsFor(row.template)) {
                await save(id, { step: `install_${step.id}` });
                await log(row, "provision.install.started", `Installing ${step.label}.`, "info", {
                    step: step.id,
                });

                const result = await runInstallStep(target, step);
                if (!result.ok) {
                    await log(row, "provision.install.failed", `${step.label} failed.`, "error", {
                        step: step.id,
                        tail: result.tail,
                    });
                    throw new Error(`${step.label} failed. ${result.tail}`);
                }

                await log(row, "provision.install.completed", `${step.label} installed.`, "success", {
                    step: step.id,
                });
            }

            // 6. Add it to the Servers list, on the same team as the provision.
            if (!Number(row.server_id)) {
                const server = (await Server.create({
                    name: row.name,
                    host: row.ip,
                    port: 22,
                    ssh_user: "root",
                    ssh_key: row.ssh_key,
                    status: "online",
                    user_id: row.user_id,
                    team_id: teamId,
                })) as { id: number } | null;

                if (!server) throw new Error("The machine is up, but the server record couldn't be saved.");
                await save(id, { server_id: server.id });
                row = await load(id);
            }

            // 6b. Firewall defaults (SSH, HTTP, HTTPS) and switch ufw on.
            // Skipped for Bare, which has no ufw. A failure here never fails the
            // provision: the machine is usable, and the Firewall page's Sync retries it.
            if (row.template !== "bare") {
                await save(id, { step: "firewall" });
                try {
                    const fw = await syncFirewall(
    { id: Number(row.server_id), user_id: row.user_id, team_id: teamId, port: 22 },
    target,
);
                    if (fw.enableError || fw.failed > 0) {
                        await log(
                            row,
                            "provision.firewall.warning",
                            fw.enableError || `${fw.failed} firewall rule(s) failed. Open Firewall and press Sync.`,
                            "warning",
                        );
                    } else {
                        await log(row, "provision.firewall.ready", "Firewall rules applied and ufw enabled.", "success");
                    }
                } catch (error) {
                    await log(
                        row,
                        "provision.firewall.warning",
                        "Couldn't set up the firewall. Open Firewall and press Sync.",
                        "warning",
                    );
                    console.error(`Provision ${id}: firewall setup failed:`, error instanceof Error ? error.message : error);
                }
            }

            // Link every earlier event of this provision to the server record.
            // Runs on resumes too, so a crash between create and attach heals itself.
            await ServerLogService.attachProvision(id, Number(row.server_id));

            await log(row, "provision.server_added", `"${row.name}" was added to your servers.`, "success", {
                host: row.ip,
            });

            await save(id, { step: "provisioned", status: "done", error: "" });
            await log(row, "provision.completed", "Provisioning finished.", "success");
        } catch (error) {
            // "Linode: ..." / "Hetzner: ..." / "Vultr: ..." / "AWS: ..." prefix comes from the adapter.
            const message =
                adapter?.describeError(error) ??
                (error instanceof Error ? error.message : "Unknown error.");

            await save(id, { status: "failed", error: message.slice(0, 500) }).catch(() => {});

            // Re-read the row so the failure event carries the step it died on.
            const latest = await load(id).catch(() => row);
            await log(latest, "provision.failed", message, "error", { step: latest.step });

            throw error;
        }
    },
};