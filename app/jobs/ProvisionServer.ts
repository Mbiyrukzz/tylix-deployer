/**
 * Job: ProvisionServer
 *
 * Creates a machine at the provider, waits for SSH, installs the template's
 * components, then adds it to the Servers list. Run by `npx tylix queue:work`,
 * which has no timeout, no retry and no crash recovery, so this job is written
 * to be re-runnable:
 *
 *   - the keypair is saved (encrypted) before anything is created
 *   - the instance is tagged tylix-provision-<id>; a re-run adopts it
 *     instead of creating a second billable machine
 *   - instance_id is saved the moment the provider accepts the create call
 *   - installers leave marker files on the server, so a re-run skips finished
 *     components (see services/Installers.ts)
 *   - every failure is written to the provision row (never including tokens)
 *
 * PROVISION_DRY_RUN=1 runs every check except the create call.
 */

import { Provision } from "../models/Provision.js";
import { Provider } from "../models/Provider.js";
import { Server } from "../models/Server.js";
import { CryptoService } from "../services/CryptoService.js";
import {
    LinodeClient,
    LinodeError,
    generateRootPassword,
    type LinodeInstance,
} from "../services/LinodeClient.js";
import { generateKeyPair, derivePublicKey, sshExec } from "../services/Ssh.js";
import { installStepsFor, runInstallStep } from "../services/Installers.js";

const BOOT_TIMEOUT_MS = 6 * 60 * 1000;
const BOOT_POLL_MS = 5_000;
const SSH_TIMEOUT_MS = 6 * 60 * 1000;
const SSH_POLL_MS = 10_000;

interface ProvisionRow {
    id: number;
    user_id: number;
    provider_id: number;
    name: string;
    region: string;
    plan: string;
    image: string;
    template: string;
    step: string;
    status: string;
    instance_id: number;
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

async function waitForRunning(linode: LinodeClient, instanceId: number): Promise<string> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;

    while (Date.now() < deadline) {
        try {
            const instance: LinodeInstance = await linode.getInstance(instanceId);
            if (instance.status === "running" && instance.ipv4[0]) {
                return instance.ipv4[0];
            }
        } catch (error) {
            const transient = error instanceof LinodeError && (error.status === 0 || error.status >= 500);
            if (!transient) throw error;
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

        try {
            const provider = (await Provider.find(row.provider_id)) as
                | { user_id: number; api_token: string }
                | null;

            if (!provider || provider.user_id !== row.user_id) {
                throw new Error("The provider connection no longer exists.");
            }

            const linode = new LinodeClient(CryptoService.decrypt(provider.api_token));

            if (dryRun) {
                await linode.verify();
                await generateKeyPair(`dry-run-${id}`);
                await save(id, { step: "dry_run_ok", status: "dry_run", error: "" });
                return;
            }

            await save(id, { status: "running", error: "" });

            // 1. Keypair: saved before anything billable exists.
            if (!row.ssh_key) {
                const pair = await generateKeyPair(`tylix-deploy-${id}`);
                await save(id, { ssh_key: CryptoService.encrypt(pair.privateKey) });
                row = await load(id);
            }
            const privateKey = CryptoService.decrypt(row.ssh_key);


            if (!row.root_password) {
                await save(id, { root_password: CryptoService.encrypt(generateRootPassword()) });
                row = await load(id);
            }
            const rootPassword = CryptoService.decrypt(row.root_password);

            // 2. Create (or adopt) the instance.
            if (!Number(row.instance_id)) {
                await save(id, { step: "creating" });

                const tag = `tylix-provision-${id}`;
                let instance = await linode.findByLabel(row.name);

                if (instance && !instance.tags.includes(tag)) {
                    throw new Error(`A Linode named "${row.name}" already exists in this account. Choose another name.`);
                }

                if (!instance) {
                    instance = await linode.createInstance({
                        region: row.region,
                        type: row.plan,
                        image: row.image,
                        label: row.name,
                        rootPassword,
                        authorizedKeys: [await derivePublicKey(privateKey)],
                        tags: [tag, "tylix-deploy"],
                    });
                }

                await save(id, { instance_id: instance.id, step: "booting" });
                row = await load(id);
            }

            // 3. Wait for it to boot and get its address.
            if (!row.ip) {
                await save(id, { step: "booting" });
                const ip = await waitForRunning(linode, Number(row.instance_id));
                await save(id, { ip, step: "waiting_ssh" });
                row = await load(id);
            }

            // 4. Wait until we can log in with our key. Instant when it is already up.
            await save(id, { step: "waiting_ssh" });
            await waitForSsh(row.ip, privateKey);

            // 5. Install the template's components, one step at a time.
            // Each step is its own row step, so updated_at moves and the sweep
            // never mistakes a healthy install for a dead one.
            const target = { host: row.ip, port: 22, user: "root", privateKey };
            for (const step of installStepsFor(row.template)) {
                await save(id, { step: `install_${step.id}` });

                const result = await runInstallStep(target, step);
                if (!result.ok) {
                    throw new Error(`${step.label} failed. ${result.tail}`);
                }
            }

            // 6. Add it to the Servers list.
            if (!Number(row.server_id)) {
                const server = (await Server.create({
                    name: row.name,
                    host: row.ip,
                    port: 22,
                    ssh_user: "root",
                    ssh_key: row.ssh_key,
                    status: "online",
                    user_id: row.user_id,
                })) as { id: number } | null;

                if (!server) throw new Error("The machine is up, but the server record couldn't be saved.");
                await save(id, { server_id: server.id });
            }

            await save(id, { step: "provisioned", status: "done", error: "" });
        } catch (error) {
            const message =
                error instanceof LinodeError
                    ? `Linode: ${error.message}`
                    : error instanceof Error
                      ? error.message
                      : "Unknown error.";

            await save(id, { status: "failed", error: message.slice(0, 500) }).catch(() => {});
            throw error;
        }
    },
};
