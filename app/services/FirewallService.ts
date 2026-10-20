/**
 * Applies firewall rules on a server with `ufw`, over SSH.
 *
 * Callers should pass values that already went through validateRule(); the
 * strings are placed into a remote shell command. Free text (the rule name)
 * is quoted here as well, so it can't break out of its comment.
 *
 *   - deny rules go in at position 1, because ufw matches top to bottom and a
 *     deny placed after "allow any" would never fire
 *   - removing a rule that is already gone counts as success
 *   - non-root users run ufw through `sudo -n`
 *   - "ufw is not installed" is checked once, up front, and is the only
 *     thing that produces exit code 127
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

/** Exits 127 when ufw is missing, so failure() can tell "not installed" from a real ufw error. */
const CHECK = "command -v ufw >/dev/null 2>&1 || exit 127";

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function ufw(target: SshTarget, args: string): string {
    const sudo = target.user === "root" ? "" : "sudo -n ";
    return `${sudo}ufw ${args}`;
}

function spec(r: RuleSpec): string {
    return `proto ${r.protocol} from ${r.source} to any port ${r.port}`;
}

/** The ufw comment: quoted for the shell, with control characters turned into spaces. */
function commentFor(rule: RuleSpec): string {
    const clean = `tylix: ${rule.name}`.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 100);
    return `comment ${sq(clean)}`;
}

function failure(result: { code: number; stdout: string; stderr: string }): FirewallResult {
    if (result.code === 127) return { ok: false, error: NOT_INSTALLED };

    const text = (result.stderr.trim() || result.stdout.trim()).split("\n").pop() ?? "";
    return { ok: false, error: (text || `ufw exited with code ${result.code}.`).slice(0, 300) };
}

export const FirewallService = {
    async apply(target: SshTarget, rule: RuleSpec): Promise<FirewallResult> {
        const comment = commentFor(rule);

        // Deny: try position 1 first; if ufw refuses it (for example when there are no
        // rules yet), append instead. Allow: a plain append.
        const run =
            rule.type === "deny"
                ? `${ufw(target, `insert 1 deny ${spec(rule)} ${comment}`)} || ${ufw(target, `deny ${spec(rule)} ${comment}`)}`
                : ufw(target, `allow ${spec(rule)} ${comment}`);

        const result = await sshExec(target, `${CHECK}; ${run}`);
        return result.code === 0 ? { ok: true } : failure(result);
    },

    async remove(target: SshTarget, rule: RuleSpec): Promise<FirewallResult> {
        // Comments are ignored when matching, so the spec alone finds the rule.
        const result = await sshExec(target, `${CHECK}; ${ufw(target, `--force delete ${rule.type} ${spec(rule)}`)}`);
        return result.code === 0 ? { ok: true } : failure(result);
    },

    /** Safe defaults, then turn the firewall on. Allow SSH BEFORE calling this. */
    async enable(target: SshTarget): Promise<FirewallResult> {
        const run = [
            ufw(target, "default deny incoming"),
            ufw(target, "default allow outgoing"),
            ufw(target, "--force enable"),
        ].join(" && ");

        const result = await sshExec(target, `${CHECK}; ${run}`, 60_000);
        return result.code === 0 ? { ok: true } : failure(result);
    },
};