/**
 * The files a Flux cron job is made of on the server, shared by the Cron jobs
 * routes and the server importer (so an imported job is written exactly like
 * one created on the Cron jobs page).
 *
 * Each job is /etc/cron.d/tylix-cron-<id>, running as the job's user, with its
 * output appended to /var/log/tylix-cron-<id>.log. Scripts run as root.
 */

export const PRESETS = ["@reboot", "@hourly", "@daily", "@weekly", "@monthly", "@yearly"];
export const FIELD = /^[0-9*\/,\-]+$/;
export const FIELD_MAX = [59, 23, 31, 12, 7]; // minute, hour, day of month, month, day of week

export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const jobName = (id: number) => `tylix-cron-${id}`;
// No dots in the file name: Debian's cron ignores /etc/cron.d files that contain one.
export const confPath = (id: number) => `/etc/cron.d/${jobName(id)}`;
export const logPath = (id: number) => `/var/log/${jobName(id)}.log`;

/** Returns the cleaned schedule, or null when it isn't a valid 5-field schedule or @preset. */
export function checkSchedule(raw: string): string | null {
    if (PRESETS.includes(raw)) return raw;

    const parts = raw.split(/\s+/);
    if (parts.length !== 5) return null;

    for (let i = 0; i < 5; i++) {
        const part = parts[i];
        if (!FIELD.test(part)) return null;
        if (/\/0+(,|$)/.test(part)) return null; // a step of 0 is rejected by cron
        for (const n of part.match(/\d+/g) ?? []) {
            if (Number(n) > FIELD_MAX[i]) return null;
        }
    }
    return parts.join(" ");
}

export function cronFile(id: number, j: { command: string; user: string; schedule: string }): string {
    // % means "newline" in a crontab, so it has to be escaped. The command goes through
    // single-quoted bash -c, so a # in it can't comment out the redirect that follows.
    const command = j.command.replace(/%/g, "\\%");
    return [
        "PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin",
        `${j.schedule} ${j.user} /bin/bash -c ${sq(command)} >> ${logPath(id)} 2>&1`,
        "", // cron.d files must end with a newline
    ].join("\n");
}

export const NO_CRON =
    '[ -d /etc/cron.d ] || { echo "Cron is not installed on this server. Install it first (Packages)." >&2; exit 4; }';
export const userExists = (user: string) =>
    `id -u ${sq(user)} >/dev/null 2>&1 || { echo "User ${user} does not exist on this server." >&2; exit 3; }`;

export function installScript(id: number, j: { command: string; user: string; schedule: string }): string {
    return [
        "set -e",
        NO_CRON,
        userExists(j.user),
        `cat > ${confPath(id)} <<'TYLIX_CRON_EOF'`,
        cronFile(id, j).trimEnd(),
        "TYLIX_CRON_EOF",
        `chmod 644 ${confPath(id)}`,
        `touch ${logPath(id)}`,
        `chown ${sq(j.user)} ${logPath(id)}`,
        // One shared logrotate rule so job logs never fill the disk.
        "if [ -d /etc/logrotate.d ] && [ ! -f /etc/logrotate.d/tylix-cron ]; then",
        "  printf '%s\\n' '/var/log/tylix-cron-*.log {' '  weekly' '  rotate 4' '  compress' '  missingok' '  notifempty' '  copytruncate' '}' > /etc/logrotate.d/tylix-cron",
        "fi",
    ].join("\n");
}

export function removeScript(id: number): string {
    return `rm -f ${confPath(id)} ${logPath(id)} ${logPath(id)}.*`;
}

