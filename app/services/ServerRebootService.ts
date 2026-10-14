/**
 * Reboots a server over SSH using the shared sshExec helper.
 *
 * The reboot is detached on the remote side (sleep 1, then systemctl reboot)
 * so the SSH session exits cleanly with code 0 instead of being cut off
 * mid-command. Non-root users need passwordless sudo (`sudo -n`).
 *
 * Raw ssh stderr is never returned to the client; it is mapped to a message.
 */

import { CryptoService } from "./CryptoService.js";
import { sshExec } from "./Ssh.js";

export interface RebootTarget {
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string; // encrypted, as stored
}

export interface RebootResult {
    ok: boolean;
    error?: string;
}

const INNER = "nohup sh -c 'sleep 1; systemctl reboot' >/dev/null 2>&1 &";

function explain(stderr: string): string {
    if (/password is required|a terminal is required|not in the sudoers/i.test(stderr)) {
        return "The SSH user needs root or passwordless sudo to reboot this server.";
    }
    if (/permission denied|publickey/i.test(stderr)) {
        return "The server rejected the stored SSH key.";
    }
    if (/timed out|refused|no route|could not resolve|unreachable/i.test(stderr)) {
        return "Couldn't reach the server over SSH. It may already be offline.";
    }
    return "The reboot command failed.";
}

export class ServerRebootService {
    static async reboot(target: RebootTarget): Promise<RebootResult> {
        let privateKey: string;

        try {
            privateKey = CryptoService.decrypt(target.ssh_key);
        } catch {
            return { ok: false, error: "Couldn't read the stored SSH key." };
        }

        const command =
            target.ssh_user === "root" ? INNER : `sudo -n sh -c "${INNER}"`;

        const result = await sshExec(
            {
                host: target.host,
                port: target.port,
                user: target.ssh_user,
                privateKey,
            },
            command,
            20_000,
        );

        if (result.code === 0) return { ok: true };

        return { ok: false, error: explain(result.stderr) };
    }
}