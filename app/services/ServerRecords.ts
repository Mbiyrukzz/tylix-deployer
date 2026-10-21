/**
 * Service: ServerRecords
 *
 * One place that removes a server's records and everything that hangs off it,
 * so ServerController.destroy and ProvisionController.destroy can't drift apart.
 * The caller checks for sites first (see siteCount).
 */

import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { DbUser } from "../models/DbUser.js";
import { ServerDatabase } from "../models/ServerDatabase.js";
import { ServerSshKey } from "../models/ServerSshKey.js";
import { ServerWorker } from "../models/ServerWorker.js";
import { ServerCronJob } from "../models/ServerCronJob.js";
import { ServerBackup } from "../models/ServerBackup.js";
import { ServerFirewallRule } from "../models/ServerFirewallRule.js";
import { ServerTask } from "../models/ServerTask.js";
import { ServerLogService } from "./ServerLogService.js";

type Deletable = {
    all(): Promise<unknown[]>;
    delete(id: number): Promise<unknown>;
};

async function removeWhere(model: Deletable, serverId: number): Promise<void> {
    const rows = (await model.all()) as { id: number; server_id: number }[];
    for (const r of rows) {
        if (Number(r.server_id) === serverId) await model.delete(r.id);
    }
}

export const ServerRecords = {
    /** How many sites still live on the server. */
    async siteCount(serverId: number): Promise<number> {
        const sites = (await Site.all()) as { server_id: number }[];
        return sites.filter((s) => Number(s.server_id) === serverId).length;
    },

    /** Deletes the server's child records, its log, then the server row itself. */
    async removeAll(serverId: number): Promise<void> {
        const children = [
            ServerDatabase,
            DbUser,
            ServerSshKey,
            ServerWorker,
            ServerCronJob,
            ServerBackup,
            ServerFirewallRule,
            ServerTask,
        ] as unknown as Deletable[];

        for (const model of children) {
            await removeWhere(model, serverId);
        }

        await ServerLogService.deleteForServer(serverId);
        await Server.delete(serverId);
    },
};