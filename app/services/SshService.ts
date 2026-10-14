/**
 * SSH helpers built on the system `ssh` and `ssh-keygen` binaries.
 *
 * Private keys are written to a temp dir with mode 0600 for the duration of
 * one command and the directory is always removed afterwards.
 *
 * Host keys: StrictHostKeyChecking=accept-new trusts a server's key on first
 * contact (into a throwaway known_hosts file). Pinning the key per server is
 * a later hardening step.
 */

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SshTarget {
    host: string;
    port: number;
    user: string;
    privateKey: string;
}

export interface SshResult {
    code: number;
    stdout: string;
    stderr: string;
}

function withNewline(key: string): string {
    return key.endsWith("\n") ? key : key + "\n";
}

/** Generates an ed25519 keypair without a passphrase. */
export async function generateKeyPair(
    comment: string,
): Promise<{ privateKey: string; publicKey: string }> {
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
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`,
            "-o", "ConnectTimeout=10",
            `${target.user}@${target.host}`,
            command,
        ];

        try {
            const { stdout, stderr } = await run("ssh", args, {
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024,
            });
            return { code: 0, stdout, stderr };
        } catch (error) {
            const e = error as { code?: number | string; stdout?: string; stderr?: string };
            return {
                code: typeof e.code === "number" ? e.code : 255,
                stdout: e.stdout ?? "",
                stderr: e.stderr ?? "",
            };
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}