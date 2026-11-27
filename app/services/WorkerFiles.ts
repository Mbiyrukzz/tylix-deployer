/**
 * The Supervisor config a Flux worker is made of on the server, shared by the
 * Workers routes and the server importer (so an imported worker is written
 * exactly like one created on the Workers page).
 *
 * Each worker is the program tylix-worker-<id> in
 * /etc/supervisor/conf.d/tylix-worker-<id>.conf, logging to
 * /var/log/tylix-worker-<id>.log. Scripts run as root.
 */

export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const program = (id: number) => `tylix-worker-${id}`;
export const confPath = (id: number) => `/etc/supervisor/conf.d/${program(id)}.conf`;
export const logPath = (id: number) => `/var/log/${program(id)}.log`;

export function supervisorConf(id: number, w: { command: string; directory: string; user: string; processes: number }) {
    // % is Supervisor's interpolation character; double it so the command is taken literally.
    const command = w.command.replace(/%/g, "%%");
    return [
        `[program:${program(id)}]`,
        "process_name=%(program_name)s_%(process_num)02d",
        `command=${command}`,
        `directory=${w.directory}`,
        `user=${w.user}`,
        `numprocs=${w.processes}`,
        "autostart=true",
        "autorestart=true",
        "stopasgroup=true",
        "killasgroup=true",
        "stopwaitsecs=3600",
        "redirect_stderr=true",
        `stdout_logfile=${logPath(id)}`,
        "stdout_logfile_maxbytes=10MB",
        "stdout_logfile_backups=3",
    ].join("\n");
}

export const NO_SUPERVISOR =
    'command -v supervisorctl >/dev/null 2>&1 || { echo "Supervisor is not installed on this server. Install it first (Packages)." >&2; exit 4; }';

export function installScript(id: number, w: { command: string; directory: string; user: string; processes: number }): string {
    return [
        "set -e",
        NO_SUPERVISOR,
        `id -u ${sq(w.user)} >/dev/null 2>&1 || { echo "User ${w.user} does not exist on this server." >&2; exit 3; }`,
        `[ -d ${sq(w.directory)} ] || { echo "Directory ${w.directory} does not exist on this server." >&2; exit 5; }`,
        `cat > ${confPath(id)} <<'TYLIX_WORKER_EOF'`,
        supervisorConf(id, w),
        "TYLIX_WORKER_EOF",
        "supervisorctl reread >/dev/null",
        "supervisorctl update >/dev/null",
    ].join("\n");
}

export function removeScript(id: number): string {
    return [
        "if command -v supervisorctl >/dev/null 2>&1; then",
        `  supervisorctl stop ${sq(program(id) + ":*")} >/dev/null 2>&1 || true`,
        `  rm -f ${confPath(id)}`,
        "  supervisorctl reread >/dev/null 2>&1 || true",
        "  supervisorctl update >/dev/null 2>&1 || true",
        "else",
        `  rm -f ${confPath(id)}`,
        "fi",
        `rm -f ${logPath(id)} ${logPath(id)}.*`,
    ].join("\n");
}
