/**
 * Server settings work over SSH: connection test, system details, services,
 * timezone, hostname, automatic updates, reboot and deploy-key rotation.
 *
 * Every script runs as the server's ssh_user (root or passwordless sudo, like
 * the other services). Values reach the shell only through shellScript
 * variables, and the controller whitelists or pattern-checks them first
 * (service names, timezone, hostname).
 *
 * One change at a time per server (locked()), so a key rotation and a service
 * restart can't overlap. Reads (inspect, check) don't take the lock.
 *
 * Key rotation order matters, because the deployer must never lock itself out:
 *   1. add the new public key to authorized_keys (the old key still works)
 *   2. log in with the NEW key; if that fails, take the new key back out and stop
 *   3. save the new key (and any provision copy) in the database
 *   4. only then remove the old public key from authorized_keys
 * If step 4 fails the new key is already active; that is reported as a warning.
 *
 * Nothing here ever returns or logs a private key.
 */

import { createHash } from "node:crypto";
import { Server } from "../models/Server.js";
import { Provision } from "../models/Provision.js";
import { CryptoService } from "./CryptoService.js";
import { sshExec, generateKeyPair, derivePublicKey } from "./Ssh.js";
import { shellScript, serverTarget } from "./Shell.js";

export interface SystemServer {
    id: number;
    name: string;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
    [key: string]: unknown;
}

/** A refusal or failure with a message that is safe to show, and the status to answer with. */
export class SystemError extends Error {
    status: number;

    constructor(message: string, status = 422) {
        super(message);
        this.status = status;
    }
}

export interface SystemInfo {
    os: string;
    kernel: string;
    hostname: string;
    timezone: string;
    uptime_seconds: number;
    load: string;
    mem_total_mb: number;
    mem_used_mb: number;
    disk_total_mb: number;
    disk_used_mb: number;
    reboot_required: boolean;
    auto_updates: "on" | "off" | "unavailable";
}

export interface ServiceState {
    id: string;
    label: string;
    state: string;
}

export const TIMEZONE = /^[A-Za-z0-9_+\/-]{1,64}$/;
export const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const STATIC_SERVICES = new Map<string, string>([
    ["nginx", "nginx"],
    ["mysql", "MySQL"],
    ["mariadb", "MariaDB"],
    ["redis-server", "Redis"],
    ["supervisor", "Supervisor"],
]);
const PHP_FPM = /^php\d\.\d-fpm$/;

export const isRestartable = (id: string) => STATIC_SERVICES.has(id) || PHP_FPM.test(id);

const labelFor = (id: string) => STATIC_SERVICES.get(id) ?? id.replace(/^php(\d)\.(\d)-fpm$/, "PHP $1.$2-FPM");

// ---- scripts (plain bash: no template placeholders other than the shellScript variables) ----

const INSPECT = `
PRETTY_NAME=""
if [ -r /etc/os-release ]; then . /etc/os-release || true; fi
echo "os=$PRETTY_NAME"
echo "kernel=$(uname -r)"
echo "hostname=$(hostname)"
echo "uptime_seconds=$(cut -d. -f1 /proc/uptime)"
echo "timezone=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
free -m | awk '/^Mem:/ {print "mem_total_mb="$2; print "mem_used_mb="$3}'
df -BM --output=size,used / | awk 'NR==2 {gsub("M","",$1); gsub("M","",$2); print "disk_total_mb="$1; print "disk_used_mb="$2}'
if [ -f /var/run/reboot-required ]; then echo "reboot_required=1"; else echo "reboot_required=0"; fi
UNAT="unavailable"
if command -v apt-get >/dev/null 2>&1; then
  if grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then UNAT="on"; else UNAT="off"; fi
fi
echo "auto_updates=$UNAT"
for s in nginx mysql mariadb redis-server supervisor; do
  if systemctl cat "$s.service" >/dev/null 2>&1; then
    echo "svc=$s|$(systemctl is-active "$s.service" 2>/dev/null || true)"
  fi
done
for f in /lib/systemd/system/php*-fpm.service /usr/lib/systemd/system/php*-fpm.service; do
  [ -f "$f" ] || continue
  n="$(basename "$f" .service)"
  echo "svc=$n|$(systemctl is-active "$n.service" 2>/dev/null || true)"
done`;

const RESTART = `
UNIT="$SERVICE.service"
if ! systemctl cat "$UNIT" >/dev/null 2>&1; then
  echo "$SERVICE isn't installed on this server." >&2
  exit 3
fi
if [ "$SERVICE" = "nginx" ]; then
  if ! OUT="$($SUDO nginx -t 2>&1)"; then
    echo "$OUT" >&2
    echo "The nginx config test failed, so nginx was not restarted." >&2
    exit 3
  fi
fi
$SUDO systemctl restart "$UNIT"
sleep 2
if $SUDO systemctl is-active --quiet "$UNIT"; then
  echo "$SERVICE restarted"
else
  $SUDO journalctl -u "$UNIT" -n 15 --no-pager >&2 || true
  exit 4
fi`;

const TIMEZONE_SCRIPT = `
if ! command -v timedatectl >/dev/null 2>&1; then
  echo "This server has no timedatectl, so its timezone can't be changed here." >&2
  exit 3
fi
LIST="$(timedatectl list-timezones 2>/dev/null || true)"
if ! echo "$LIST" | grep -Fxq "$ZONE"; then
  echo "The server doesn't know a timezone called $ZONE. Use a name like Africa/Nairobi." >&2
  exit 3
fi
$SUDO timedatectl set-timezone "$ZONE"
echo "Timezone is now $ZONE"`;

const HOSTNAME_SCRIPT = `
OLD="$(hostname)"
$SUDO hostnamectl set-hostname "$NEW_HOST"
if grep -q '^127.0.1.1' /etc/hosts; then
  $SUDO sed -i "s/^127.0.1.1.*/127.0.1.1 $NEW_HOST/" /etc/hosts
else
  echo "127.0.1.1 $NEW_HOST" | $SUDO tee -a /etc/hosts >/dev/null
fi
echo "Hostname is now $NEW_HOST (it was $OLD)"`;

const UPDATES_SCRIPT = `
if ! command -v apt-get >/dev/null 2>&1; then
  echo "Automatic updates can only be managed on Debian and Ubuntu servers." >&2
  exit 3
fi
VALUE=0
if [ "$ENABLE" = "1" ]; then
  VALUE=1
  if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
    if ! $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null 2>&1; then
      echo "Couldn't install unattended-upgrades. Another package task may be running; try again in a minute." >&2
      exit 3
    fi
  fi
fi
cat <<CONF | $SUDO tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "$VALUE";
CONF
echo "Automatic security updates are now $ENABLE"`;

const REBOOT = `
if command -v systemd-run >/dev/null 2>&1; then
  $SUDO systemd-run --on-active=3 --unit="tylix-reboot-$(date +%s)" systemctl reboot >/dev/null 2>&1
else
  $SUDO shutdown -r +1 >/dev/null 2>&1
fi
echo "Reboot scheduled"`;

const ADD_KEY = `
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
BLOB="$(echo "$NEW_KEY" | cut -d' ' -f2)"
if ! grep -qF "$BLOB" "$HOME/.ssh/authorized_keys"; then
  echo "$NEW_KEY" >> "$HOME/.ssh/authorized_keys"
fi
echo "key added"`;

/** Removes one public key (matched by its base64 body) and keeps the other one in place. */
const DROP_KEY = `
F="$HOME/.ssh/authorized_keys"
DROP_BLOB="$(echo "$DROP_KEY" | cut -d' ' -f2)"
if [ -f "$F" ] && [ -n "$DROP_BLOB" ]; then
  TMP="$(mktemp)"
  grep -vF "$DROP_BLOB" "$F" > "$TMP" || true
  cat "$TMP" > "$F"
  rm -f "$TMP"
fi
KEEP_BLOB="$(echo "$KEEP_KEY" | cut -d' ' -f2)"
if ! grep -qF "$KEEP_BLOB" "$F"; then
  echo "$KEEP_KEY" >> "$F"
fi
echo "key removed"`;

// ---- helpers ----

const clean = (text: string) =>
    String(text ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("Warning: Permanently added"));

interface Result {
    code: number;
    stdout: string;
    stderr: string;
}

/** Turns a failed result into a SystemError. Exit 3 is "the script refused"; anything else is a failure. */
function fail(result: Result, what: string): never {
    const tail = clean(result.stderr || result.stdout).slice(-6).join("\n").slice(0, 1500);

    if (result.code === 3) throw new SystemError(tail || `${what} was refused by the server.`, 422);
    if (result.code === 4) throw new SystemError(`${what} didn't stay running.${tail ? "\n" + tail : ""}`, 502);

    throw new SystemError(`${what} failed.${tail ? " " + tail : ""}`, 502);
}

async function exec(server: SystemServer, vars: Record<string, string>, body: string, timeoutMs: number): Promise<Result> {
    const target = serverTarget(server as never);
    const result = (await sshExec(target, shellScript(vars, body), timeoutMs)) as Result;

    if (result.code === 255) {
        const last = clean(result.stderr).slice(-1)[0] ?? "";
        throw new SystemError(`Couldn't reach the server over SSH.${last ? " " + last.slice(0, 200) : ""}`, 502);
    }

    return result;
}

export function fingerprintOf(publicKey: string): string {
    const body = publicKey.trim().split(/\s+/)[1] ?? "";
    if (!body) return "";
    return "SHA256:" + createHash("sha256").update(Buffer.from(body, "base64")).digest("base64").replace(/=+$/, "");
}

const num = (value: string | undefined) => Number(value) || 0;

const busy = new Set<number>();

export const ServerSystem = {
    isBusy(id: number): boolean {
        return busy.has(id);
    },

    async locked<T>(id: number, fn: () => Promise<T>): Promise<T> {
        if (busy.has(id)) {
            throw new SystemError("Another change is still running on this server. Try again in a moment.", 409);
        }

        busy.add(id);
        try {
            return await fn();
        } finally {
            busy.delete(id);
        }
    },

    /** The key's fingerprint, or "" if the stored key can't be read. */
    async fingerprint(server: SystemServer): Promise<string> {
        try {
            const pub = await derivePublicKey(CryptoService.decrypt(server.ssh_key));
            return fingerprintOf(pub);
        } catch {
            return "";
        }
    },

    /** Tries to log in and saves the result on the server row. Never throws. */
    async check(server: SystemServer): Promise<{ ok: boolean; status: string; error: string; checked_at: string }> {
        const checkedAt = new Date().toISOString();
        let error = "";

        try {
            const result = await exec(server, {}, `echo ok`, 20_000);
            if (result.code !== 0) error = clean(result.stderr || result.stdout).slice(-1)[0] ?? "The test command failed.";
        } catch (err) {
            error = err instanceof Error ? err.message : "Couldn't connect.";
        }

        const status = error ? "offline" : "online";
        error = error.slice(0, 300);

        await Server.update(server.id, { status, last_checked_at: checkedAt, last_error: error });
        return { ok: !error, status, error, checked_at: checkedAt };
    },

    async inspect(server: SystemServer): Promise<{ info: SystemInfo; services: ServiceState[] }> {
        const result = await exec(server, {}, INSPECT, 30_000);
        if (result.code !== 0) fail(result, "Reading the server's details");

        const kv = new Map<string, string>();
        const services = new Map<string, ServiceState>();

        for (const line of String(result.stdout ?? "").split("\n")) {
            const eq = line.indexOf("=");
            if (eq < 1) continue;

            const key = line.slice(0, eq);
            const value = line.slice(eq + 1).trim();

            if (key === "svc") {
                const [id, state] = value.split("|");
                if (id && isRestartable(id)) services.set(id, { id, label: labelFor(id), state: state || "unknown" });
            } else {
                kv.set(key, value);
            }
        }

        const updates = kv.get("auto_updates");

        return {
            info: {
                os: kv.get("os") || "Unknown",
                kernel: kv.get("kernel") || "",
                hostname: kv.get("hostname") || "",
                timezone: kv.get("timezone") || "",
                uptime_seconds: num(kv.get("uptime_seconds")),
                load: kv.get("load") || "",
                mem_total_mb: num(kv.get("mem_total_mb")),
                mem_used_mb: num(kv.get("mem_used_mb")),
                disk_total_mb: num(kv.get("disk_total_mb")),
                disk_used_mb: num(kv.get("disk_used_mb")),
                reboot_required: kv.get("reboot_required") === "1",
                auto_updates: updates === "on" || updates === "off" ? updates : "unavailable",
            },
            services: [...services.values()],
        };
    },

    async restartService(server: SystemServer, service: string): Promise<string> {
        const result = await exec(server, { SERVICE: service }, RESTART, 60_000);
        if (result.code !== 0) fail(result, `Restarting ${labelFor(service)}`);
        return `${labelFor(service)} was restarted.`;
    },

    async setTimezone(server: SystemServer, zone: string): Promise<string> {
        const result = await exec(server, { ZONE: zone }, TIMEZONE_SCRIPT, 30_000);
        if (result.code !== 0) fail(result, "Changing the timezone");
        return `The timezone is now ${zone}.`;
    },

    async setHostname(server: SystemServer, hostname: string): Promise<string> {
        const result = await exec(server, { NEW_HOST: hostname }, HOSTNAME_SCRIPT, 30_000);
        if (result.code !== 0) fail(result, "Changing the hostname");
        return `The hostname is now ${hostname}.`;
    },

    async setAutoUpdates(server: SystemServer, enabled: boolean): Promise<string> {
        const result = await exec(server, { ENABLE: enabled ? "1" : "0" }, UPDATES_SCRIPT, 5 * 60_000);
        if (result.code !== 0) fail(result, "Changing automatic updates");
        return enabled ? "Automatic security updates are on." : "Automatic security updates are off.";
    },

    async reboot(server: SystemServer): Promise<string> {
        const result = await exec(server, {}, REBOOT, 30_000);
        if (result.code !== 0) fail(result, "Scheduling the reboot");
        return "A reboot was scheduled. The server will be unreachable for a minute or two.";
    },

    /**
     * Replaces the deploy key. See the order of steps at the top of this file.
     * Returns the new fingerprint, and a warning if the old key couldn't be removed.
     */
    async rotateKey(server: SystemServer): Promise<{ fingerprint: string; rotated_at: string; warning: string }> {
        const oldPrivate = CryptoService.decrypt(server.ssh_key);
        const oldPublic = (await derivePublicKey(oldPrivate)).trim();

        const pair = await generateKeyPair(`tylix-deploy-${server.id}`);
        const newPrivate = pair.privateKey.endsWith("\n") ? pair.privateKey : pair.privateKey + "\n";
        const newPublic = (await derivePublicKey(newPrivate)).trim();

        // 1. Add the new key. The old key is still the one that logs in.
        const added = await exec(server, { NEW_KEY: newPublic }, ADD_KEY, 30_000);
        if (added.code !== 0) fail(added, "Installing the new key");

        // 2. Prove the new key works before anything depends on it.
        const target = serverTarget(server as never);
        const check = await sshExec({ ...target, privateKey: newPrivate }, "echo ok", 20_000);

        if (check.code !== 0) {
            // Put the server back as it was: take the new key out again, using the old key.
            await exec(server, { DROP_KEY: newPublic, KEEP_KEY: oldPublic }, DROP_KEY, 30_000).catch(() => {});
            const why = clean(check.stderr).slice(-1)[0] ?? "";
            throw new SystemError(
                `The new key was installed but couldn't log in, so nothing was changed.${why ? " " + why.slice(0, 200) : ""}`,
                502,
            );
        }

        // 3. Save it. From here on the deployer uses the new key.
        const rotatedAt = new Date().toISOString();
        const encrypted = CryptoService.encrypt(newPrivate);

        await Server.update(server.id, { ssh_key: encrypted, key_rotated_at: rotatedAt, status: "online", last_error: "" });

        try {
            const rows = (await Provision.all()) as { id: number; server_id: number }[];
            for (const row of rows) {
                if (Number(row.server_id) === server.id) await Provision.update(row.id, { ssh_key: encrypted });
            }
        } catch (err) {
            console.error(`Couldn't update the provision copy of the key for server ${server.id}:`, err);
        }

        // 4. Retire the old key, using the new one.
        let warning = "";
        try {
            const next = { ...server, ssh_key: encrypted };
            const dropped = await exec(next, { DROP_KEY: oldPublic, KEEP_KEY: newPublic }, DROP_KEY, 30_000);
            if (dropped.code !== 0) warning = "The new key is active, but the old key couldn't be removed from the server. Remove it by hand.";
        } catch {
            warning = "The new key is active, but the old key couldn't be removed from the server. Remove it by hand.";
        }

        return { fingerprint: fingerprintOf(newPublic), rotated_at: rotatedAt, warning };
    },
};
