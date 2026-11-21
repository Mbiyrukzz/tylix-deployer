/**
 * SSH helpers built on the system `ssh` and `ssh-keygen` binaries.
 *
 * Private keys are written to a temp dir with mode 0600 for the duration of
 * one command and the directory is always removed afterwards.
 *
 * Host keys: a server with a pinned key (servers.ssh_host_key) is connected to
 * with StrictHostKeyChecking=yes against a known_hosts file holding only that
 * key, so a different key fails closed. A server with no pinned key still uses
 * StrictHostKeyChecking=accept-new (trust on first contact, throwaway file)
 * and the key it presented is returned as observedHostKey so it can be pinned.
 *
 * Streaming: sshExec buffers everything and returns when the command ends
 * (that is what execFile does). Pass { onData } as the 4th argument and the
 * output is handed to your callback as it arrives instead (the full output is
 * still returned at the end). Without the option nothing changes.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Fixed known_hosts name, so the stored key is just "type base64" whatever the host, port or IP. */
const ALIAS = "tylix-pinned";

export const HOST_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+$/;

const MISMATCH_RE = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i;

const MAX_BUFFER = 10 * 1024 * 1024;

export interface SshTarget {
    host: string;
    port: number;
    user: string;
    privateKey: string;
    /** Pinned host key, "ssh-ed25519 AAAA...". Null or missing means not pinned yet. */
    hostKey?: string | null;
}

export interface SshResult {
    code: number;
    stdout: string;
    stderr: string;
    /** True when a pinned key was set and the server presented a different one. */
    hostKeyMismatch?: boolean;
    /** The key the server presented. Only set on success and only when no key was pinned. */
    observedHostKey?: string | null;
}

export interface SshExecOptions {
    /**
     * Called with each chunk of output as it arrives (stdout and stderr, in the
     * order they arrive). Chunks can end mid-line. Errors thrown by the callback
     * are ignored. The full output is still returned in the result.
     */
    onData?: (chunk: string, stream: "stdout" | "stderr") => void;
}

function withNewline(key: string): string {
    return key.endsWith("\n") ? key : key + "\n";
}

/** SHA256:xxxx, the same format as `ssh-keygen -l`. */
export function hostKeyFingerprint(hostKey: string): string {
    const raw = Buffer.from(hostKey.split(" ")[1] ?? "", "base64");
    return "SHA256:" + createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
}

/** The ssh -o options for host-key handling. Shared by sshExec and Terminal. `dir` is the caller's temp dir. */
export async function hostKeyArgs(dir: string, hostKey?: string | null): Promise<string[]> {
    const knownHosts = join(dir, "known_hosts");
    const args = [
        "-o", `UserKnownHostsFile=${knownHosts}`,
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", `HostKeyAlias=${ALIAS}`,
        "-o", "HashKnownHosts=no",
        "-o", "UpdateHostKeys=no",
    ];

    if (hostKey && HOST_KEY_RE.test(hostKey)) {
        await writeFile(knownHosts, `${ALIAS} ${hostKey}\n`, { mode: 0o600 });
        args.push("-o", "StrictHostKeyChecking=yes");
    } else {
        args.push("-o", "StrictHostKeyChecking=accept-new");
    }

    return args;
}

/** Reads the key ssh recorded in the throwaway known_hosts after an accept-new connection. */
async function readObservedKey(dir: string): Promise<string | null> {
    const content = await readFile(join(dir, "known_hosts"), "utf8").catch(() => "");

    for (const line of content.split("\n")) {
        if (line.startsWith("#")) continue;
        const p = line.trim().split(/\s+/);
        if (p.length >= 3) return `${p[1]} ${p[2]}`;
    }

    return null;
}

/** Generates an ed25519 keypair without a passphrase. */
export async function generateKeyPair(comment: string): Promise<{ privateKey: string; publicKey: string }> {
    const dir = await mkdtemp(join(tmpdir(), "tylix-key-"));
    try {
        const file = join(dir, "id");
        await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file]);
        const [privateKey, publicKey] = await Promise.all([
            readFile(file, "utf8"),
            readFile(file + ".pub", "utf8"),
        ]);
        return { privateKey, publicKey: publicKey.trim() };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** Derives the public key from a private key. */
export async function derivePublicKey(privateKey: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tylix-key-"));
    try {
        const file = join(dir, "key");
        await writeFile(file, withNewline(privateKey), { mode: 0o600 });
        const { stdout } = await run("ssh-keygen", ["-y", "-f", file]);
        return stdout.trim();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Runs ssh and hands output to `onData` as it arrives. Same timeout and
 * buffer limits as execFile. Never rejects.
 */
function runStreaming(
    args: string[],
    timeoutMs: number,
    onData: NonNullable<SshExecOptions["onData"]>,
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        // Keep the newest output if a command prints more than the limit.
        const cap = (current: string, added: string) => {
            const next = current + added;
            return next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next;
        };

        const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        const emit = (chunk: string, stream: "stdout" | "stderr") => {
            try {
                onData(chunk, stream);
            } catch {
                // a broken callback must never break the command
            }
        };

        child.stdout.on("data", (chunk: string) => {
            stdout = cap(stdout, chunk);
            emit(chunk, "stdout");
        });
        child.stderr.on("data", (chunk: string) => {
            stderr = cap(stderr, chunk);
            emit(chunk, "stderr");
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
        }, timeoutMs);

        const finish = (code: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (timedOut) stderr += `\nssh timed out after ${Math.round(timeoutMs / 1000)}s.`;
            resolve({ code, stdout, stderr });
        };

        child.on("error", (err) => {
            stderr += `\n${err.message}`;
            finish(255);
        });
        child.on("close", (code) => finish(typeof code === "number" ? code : 255));
    });
}

/**
 * What sshd prints when the account's password has expired and the login has
 * no TTY (Hetzner expires the root password it generates, so a key login with
 * a command gets refused until the password is changed).
 */
export const PASSWORD_EXPIRED_RE =
    /password has expired|password change required|required to change your password/i;

export interface PasswordChangeResult {
    ok: boolean;
    /** True when the server never asked for a new password: it was already changed. */
    alreadyChanged?: boolean;
    /** Why the change failed. Never contains either password. */
    error?: string;
}

// Prompts from passwd / pam_unix on Debian and Ubuntu, old and new wording.
// Retype is matched before New because "Retype new password:" contains both.
const PROMPT_CURRENT = /(current|old)[^\n]*password[^\n]*:\s*$/i;
const PROMPT_RETYPE = /(retype|re-enter|again)[^\n]*password[^\n]*:\s*$/i;
const PROMPT_NEW = /new[^\n]*password[^\n]*:\s*$/i;

/** The last line that says why passwd refused, without prompts or ssh noise. */
function passwdReason(output: string): string {
    const lines = output
        .split(/\r?\n|\r/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !/password[^\n]*:\s*$/i.test(l))
        .filter((l) => !/^connection to .* closed/i.test(l))
        .filter((l) => !/^(warning: your password has expired|you must change your password|changing password for)/i.test(l));

    const hit = [...lines].reverse().find((l) =>
        /bad password|sorry|do not match|too short|too simple|unchanged|manipulation error|failure|error/i.test(l),
    );
    return (hit ?? lines.pop() ?? "").replace(/^passwd:\s*/i, "").slice(0, 200);
}

/**
 * Changes an expired root password by answering the passwd prompts that sshd
 * runs on a forced TTY (ssh -tt), logging in with the deploy key.
 *
 * `current` is only typed if the server asks for it. The new password is
 * written to the remote pty with echo off, so it never appears in the output.
 * Never throws.
 */
export async function changeExpiredPassword(
    target: SshTarget,
    current: string | null,
    next: string,
    timeoutMs = 45_000,
): Promise<PasswordChangeResult> {
    const dir = await mkdtemp(join(tmpdir(), "tylix-ssh-"));
    try {
        const keyFile = join(dir, "key");
        await writeFile(keyFile, withNewline(target.privateKey), { mode: 0o600 });

        const args = [
            "-tt",
            "-i", keyFile,
            "-p", String(target.port),
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "ConnectTimeout=10",
            ...(await hostKeyArgs(dir, target.hostKey)),
            `${target.user}@${target.host}`,
            // Only runs when no password change is forced, i.e. it was already changed.
            "exit 0",
        ];

        return await new Promise<PasswordChangeResult>((resolve) => {
            const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");

            let all = "";
            let pending = ""; // output since the last answer
            let prompted = false;
            let newPrompts = 0;
            let rejected = "";
            let settled = false;

            const finish = (result: PasswordChangeResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };

            const answer = (value: string) => {
                pending = "";
                try {
                    child.stdin.write(value + "\n");
                } catch {
                    // the close handler reports what happened
                }
            };

            const onData = (chunk: string) => {
                all = (all + chunk).slice(-20_000);
                pending += chunk;

                if (PROMPT_CURRENT.test(pending)) {
                    prompted = true;
                    if (!current) {
                        rejected = "The server asked for the current password, and none is stored for this machine.";
                        child.kill("SIGTERM");
                        return;
                    }
                    answer(current);
                } else if (PROMPT_RETYPE.test(pending)) {
                    prompted = true;
                    answer(next);
                } else if (PROMPT_NEW.test(pending)) {
                    prompted = true;
                    newPrompts += 1;
                    if (newPrompts > 1) {
                        // passwd refused the first attempt and is asking again.
                        rejected = passwdReason(pending) || "The server didn't accept that password.";
                        child.kill("SIGTERM");
                        return;
                    }
                    answer(next);
                }
            };

            child.stdout.on("data", onData);
            child.stderr.on("data", onData);

            const timer = setTimeout(() => {
                rejected = rejected || "The server took too long to respond.";
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
            }, timeoutMs);

            child.on("error", (err) => finish({ ok: false, error: `Couldn't run ssh: ${err.message}` }));

            child.on("close", (code) => {
                if (rejected) return finish({ ok: false, error: rejected });
                if (code === 0 && !prompted) return finish({ ok: true, alreadyChanged: true });
                if (code === 0 || /updated successfully|password changed/i.test(all)) return finish({ ok: true });
                if (!prompted) {
                    const last = all.trim().split("\n").pop()?.trim() ?? "";
                    return finish({ ok: false, error: last ? `Couldn't connect: ${last}` : "Couldn't connect to the server." });
                }
                return finish({ ok: false, error: passwdReason(all) || "The password change didn't complete." });
            });
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** Runs one command over SSH. Never throws: a failed connection returns a non-zero code. */
export async function sshExec(
    target: SshTarget,
    command: string,
    timeoutMs = 30_000,
    options: SshExecOptions = {},
): Promise<SshResult> {
    const dir = await mkdtemp(join(tmpdir(), "tylix-ssh-"));
    try {
        const keyFile = join(dir, "key");
        await writeFile(keyFile, withNewline(target.privateKey), { mode: 0o600 });

        const args = [
            "-i", keyFile,
            "-p", String(target.port),
            "-o", "BatchMode=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "ConnectTimeout=10",
            ...(await hostKeyArgs(dir, target.hostKey)),
            `${target.user}@${target.host}`,
            command,
        ];

        if (options.onData) {
            const { code, stdout, stderr } = await runStreaming(args, timeoutMs, options.onData);

            if (code === 0) {
                return {
                    code,
                    stdout,
                    stderr,
                    observedHostKey: target.hostKey ? null : await readObservedKey(dir),
                };
            }

            return {
                code,
                stdout,
                stderr,
                hostKeyMismatch: Boolean(target.hostKey) && MISMATCH_RE.test(stderr),
            };
        }

        try {
            const { stdout, stderr } = await run("ssh", args, {
                timeout: timeoutMs,
                maxBuffer: MAX_BUFFER,
            });
            return {
                code: 0,
                stdout,
                stderr,
                observedHostKey: target.hostKey ? null : await readObservedKey(dir),
            };
        } catch (error) {
            const e = error as { code?: number | string; stdout?: string; stderr?: string };
            const stderr = e.stderr ?? "";
            return {
                code: typeof e.code === "number" ? e.code : 255,
                stdout: e.stdout ?? "",
                stderr,
                hostKeyMismatch: Boolean(target.hostKey) && MISMATCH_RE.test(stderr),
            };
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}