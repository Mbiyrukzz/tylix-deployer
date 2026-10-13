/**
 * Job: InstallPackages
 *
 * Installs packages from the catalog (services/Installers.ts) on an existing
 * server over SSH. Re-runnable: installers skip finished components.
 * Progress is written to the server_tasks row, one step at a time.
 */

import { ServerTask } from "../models/ServerTask.js";
import { Server } from "../models/Server.js";
import { CryptoService } from "../services/CryptoService.js";
import { stepsForPackages, runInstallStep } from "../services/Installers.js";

interface TaskRow {
    id: number;
    user_id: number;
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
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
    [key: string]: unknown;
}

async function save(id: number, patch: Record<string, unknown>): Promise<void> {
    await ServerTask.update(id, patch);
}

export const InstallPackages = {
    async handle(payload: { taskId: number | string; [key: string]: unknown }) {
        const id = Number(payload.taskId);
        const task = (await ServerTask.find(id)) as TaskRow | null;
        if (!task) throw new Error(`Task ${id} not found.`);
        if (task.status === "done") return;

        try {
            const server = (await Server.find(task.server_id)) as ServerRow | null;
            if (!server || server.user_id !== task.user_id) {
                throw new Error("That server no longer exists.");
            }

            const ids = JSON.parse(task.packages) as string[];
            const steps = stepsForPackages(ids);

            const target = {
                host: server.host,
                port: Number(server.port),
                user: server.ssh_user,
                privateKey: CryptoService.decrypt(server.ssh_key),
            };

            await save(id, { status: "running", error: "" });

            for (const step of steps) {
                await save(id, { step: step.label });

                const result = await runInstallStep(target, step);
                if (!result.ok) {
                    throw new Error(`${step.label} failed. ${result.tail}`);
                }
            }

            await save(id, { step: "Finished", status: "done", error: "" });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error.";
            await save(id, { status: "failed", error: message.slice(0, 500) }).catch(() => {});
            throw error;
        }
    },
};
