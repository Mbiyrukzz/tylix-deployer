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
 */

import { execFile } from "node:child_process";
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

/** Runs one command over SSH. Never throws: a failed connection returns a non-zero code. */
export async function sshExec(
    target: SshTarget,
    command: string,
    timeoutMs = 30_000,
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

        try {
            const { stdout, stderr } = await run("ssh", args, {
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024,
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