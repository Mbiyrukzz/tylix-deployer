/**
 * Applies firewall rules on a server with `ufw`, over SSH.
 *
 * Callers must pass values that already went through validateRule(); the
 * strings are placed into a remote shell command.
 *
 *   - deny rules go in at position 1, because ufw matches top to bottom and a
 *     deny placed after "allow any" would never fire
 *   - removing a rule that is already gone counts as success
 *   - non-root users run ufw through `sudo -n`
 */

import { sshExec, type SshTarget } from "./Ssh.js";

export interface RuleSpec {
    name: string;
    type: string;
    source: string;
    protocol: string;
    port: string;
}

export interface FirewallResult {
    ok: boolean;
    error?: string;
}

const NOT_INSTALLED = "UFW isn't installed on this server. The Bare template doesn't include it.";

function ufw(target: SshTarget, args: string): string {
    const sudo = target.user === "root" ? "" : "sudo -n ";
    return `command -v ufw >/dev/null 2>&1 || exit 127; ${sudo}ufw ${args}`;
}

function spec(r: RuleSpec): string {
    return `proto ${r.protocol} from ${r.source} to any port ${r.port}`;
}

function failure(result: { code: number; stdout: string; stderr: string }): FirewallResult {
    if (result.code === 127) return { ok: false, error: NOT_INSTALLED };

    const text = (result.stderr.trim() || result.stdout.trim()).split("\n").pop() ?? "";
    return { ok: false, error: (text || `ufw exited with code ${result.code}.`).slice(0, 300) };
}

export const FirewallService = {
    async apply(target: SshTarget, rule: RuleSpec): Promise<FirewallResult> {
        const comment = `comment 'tylix: ${rule.name}'`;

        const command =
            rule.type === "deny"
                ? `${ufw(target, `insert 1 deny ${spec(rule)} ${comment}`)} || ${ufw(target, `deny ${spec(rule)} ${comment}`)}`
                : ufw(target, `allow ${spec(rule)} ${comment}`);

        const result = await sshExec(target, command);
        return result.code === 0 ? { ok: true } : failure(result);
    },

    async remove(target: SshTarget, rule: RuleSpec): Promise<FirewallResult> {
        // Comments are ignored when matching, so the spec alone finds the rule.
        const result = await sshExec(target, ufw(target, `--force delete ${rule.type} ${spec(rule)}`));
        return result.code === 0 ? { ok: true } : failure(result);
    },

    /** Safe defaults, then turn the firewall on. Allow SSH BEFORE calling this. */
    async enable(target: SshTarget): Promise<FirewallResult> {
        const command = [
            ufw(target, "default deny incoming"),
            ufw(target, "default allow outgoing"),
            ufw(target, "--force enable"),
        ].join(" && ");

        const result = await sshExec(target, command, 60_000);
        return result.code === 0 ? { ok: true } : failure(result);
    },
};