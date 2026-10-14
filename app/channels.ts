import { registerTerminal } from "./services/Terminal.js";

export async function channels(server: any) {
    registerTerminal(server);
}