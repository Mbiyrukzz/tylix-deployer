/**
 * Shared shell helpers for scripts sent to servers over SSH.
 */

import { CryptoService } from "./CryptoService.js";
import type { SshTarget } from "./Ssh.js";

/** Single-quotes a value for bash. */
export const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const FUNCTIONS = `
set -eu
export DEBIAN_FRONTEND=noninteractive
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

as_user() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$SITE_USER" -- env HOME="/home/$SITE_USER" "$@"
  else
    sudo -u "$SITE_USER" env HOME="/home/$SITE_USER" "$@"
  fi
}
`;

/** Prepends the variables (single-quoted) and the helper functions to a script body. */
export function shellScript(vars: Record<string, string>, body: string): string {
    const lines = Object.entries(vars).map(([key, value]) => `${key}=${q(value)}`);
    return lines.join("\n") + "\n" + FUNCTIONS + "\n" + body + "\n";
}

/** Turns a `servers` row into what sshExec expects (decrypts the stored key, passes the pinned host key). */
export function serverTarget(server: {
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
    ssh_host_key?: string | null;
}): SshTarget {
    return {
        host: server.host,
        port: Number(server.port),
        user: server.ssh_user,
        privateKey: CryptoService.decrypt(server.ssh_key),
        hostKey: server.ssh_host_key ?? null,
    };
}