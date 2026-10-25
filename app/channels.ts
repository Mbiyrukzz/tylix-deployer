import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerTerminal } from "./services/Terminal.js";
import { registerStats } from "./services/StatsChannel.js";
import { registerProvision } from "./services/ProvisionChannel.js";

export async function channels(server: any) {
    // `tylix channels:work` doesn't set up the database on its own (`tylix dev`
    // and `queue:work` do). This is the same bootstrap the queue worker uses.
    const bootstrapPath = path.join(process.cwd(), "node_modules", "@tylix", "cli", "src", "bootstrap.js");
    const bootstrap = await import(pathToFileURL(bootstrapPath).href);
    await bootstrap.bootstrapDatabase();

    registerTerminal(server);
    registerStats(server);
    registerProvision(server);
}