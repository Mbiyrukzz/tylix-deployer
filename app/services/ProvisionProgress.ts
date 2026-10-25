/**
 * Turns a provision row into the list of steps and a percentage.
 *
 * The step names are the ones ProvisionServer already saves in provision.step:
 *   "" (keypair), creating, booting, waiting_ssh, install_<id>..., firewall, provisioned
 * The install steps come from installStepsFor(), so they follow the template.
 * Bare has no firewall step, same as the job.
 */

import { installStepsFor } from "./Installers.js";

export interface ProvisionRow {
    id: number;
    user_id: number;
    team_id: number | null;
    name: string;
    template: string;
    step: string;
    status: string;
    error: string;
    ip: string;
    server_id: number;
    [key: string]: unknown;
}

export interface ProgressStep {
    id: string;
    label: string;
    state: "done" | "running" | "failed" | "pending";
}

export interface Progress {
    id: number;
    name: string;
    status: string;
    step: string;
    percent: number;
    error: string;
    ip: string;
    server_id: number;
    steps: ProgressStep[];
}

const START = [
    { id: "keypair", label: "Generate the deploy key" },
    { id: "creating", label: "Create the machine" },
    { id: "booting", label: "Wait for it to boot" },
    { id: "waiting_ssh", label: "Wait for SSH" },
];

export function progressOf(row: ProvisionRow): Progress {
    const installs = installStepsFor(row.template).map((s) => ({
        id: `install_${s.id}`,
        label: `Install ${s.label}`,
    }));
    const firewall = row.template === "bare" ? [] : [{ id: "firewall", label: "Set up the firewall" }];
    const plan = [...START, ...installs, ...firewall, { id: "provisioned", label: "Server ready" }];

    const finished = row.status === "done";
    const failed = row.status === "failed";
    const found = plan.findIndex((s) => s.id === row.step);
    const current = finished ? plan.length - 1 : Math.max(found, 0);

    const steps = plan.map(
        (s, i): ProgressStep => ({
            id: s.id,
            label: s.label,
            state: finished || i < current ? "done" : i === current ? (failed ? "failed" : "running") : "pending",
        }),
    );

    return {
        id: row.id,
        name: row.name,
        status: row.status,
        step: row.step,
        percent: finished ? 100 : Math.min(99, Math.round((current / (plan.length - 1)) * 100)),
        error: row.error || "",
        ip: row.ip || "",
        server_id: Number(row.server_id) || 0,
        steps,
    };
}