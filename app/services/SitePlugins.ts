/**
 * Plugin catalog for sites.
 *
 * Each plugin is data plus two bash bodies (install / uninstall) that run over
 * SSH through shellScript(), so $SUDO, as_user and `set -eu` are available.
 * Every script is idempotent, so a failed install can simply be retried.
 *
 * Vars the installer provides: SITE_USER, SITE_ROOT, DOMAIN, PHP_VERSION,
 * APP_DIR, PORT, RPC_PORT, PLUGIN.
 *
 * nginx plugins never edit the vhost wholesale. They drop a snippet into
 * /etc/nginx/tylix-plugins/<domain>/<plugin>.conf and make sure each server
 * block includes that folder. Every change is tested with `nginx -t` and
 * rolled back if the test fails.
 */

export interface PluginSite {
    id: number;
    type: string;
    domain: string;
    isolated_user: string;
    php_version: string;
    ssl_mode?: string;
    ssl_status?: string;
    [key: string]: unknown;
}

export interface PluginContext {
    site: PluginSite;
    port: number;
}

export interface PluginDef {
    id: string;
    name: string;
    group: string;
    description: string;
    types: string[];
    /** Needs a checkout on the server (artisan, package.json). */
    needsRepo: boolean;
    /** Allocates a free port on the server, starting here. */
    port?: { start: number };
    notes: string[];
    /** egrep pattern of .env keys to copy into the saved env after install. */
    envKeys?: string;
    install: (c: PluginContext) => string;
    uninstall: (c: PluginContext) => string;
}

const ALL = ["tylix", "laravel", "php", "nodejs", "nextjs", "wordpress", "mern", "angular", "react", "static"];
const NGINX_SERVED = ["angular", "react", "static", "mern"];

// ---------------------------------------------------------------- helpers

// composer_run: runs Composer as the site user with --no-scripts (Laravel's
// post-update scripts like vendor:publish are not needed here and hide the real
// error), hides the PHP deprecation spam from the distro Composer, and on
// failure prints the last 40 meaningful lines to stderr.
const LARAVEL_PREP = `
cd "$SITE_ROOT"
[ -f artisan ] || { echo "There is no artisan file in $SITE_ROOT. Is this a Laravel app?" >&2; exit 1; }
[ -f .env ] || { echo "There is no .env file yet. Deploy the site once (Deployment tab) so .env exists, then install the plugin." >&2; exit 1; }
PHP_BIN="$(command -v "php$PHP_VERSION")" || { echo "PHP $PHP_VERSION is not installed on this server." >&2; exit 1; }
COMPOSER_BIN="$(command -v composer)" || { echo "Composer is not installed on this server." >&2; exit 1; }
composer_run() {
  CLOG="$(mktemp)"
  if as_user "$PHP_BIN" -d error_reporting=22527 "$COMPOSER_BIN" "$@" --no-scripts --no-dev >"$CLOG" 2>&1; then
    grep -v '^Deprecation Notice:' "$CLOG" || true
    rm -f "$CLOG"
  else
    grep -v '^Deprecation Notice:' "$CLOG" | tail -n 40 >&2 || true
    rm -f "$CLOG"
    return 1
  fi
}
artisan() { as_user "$PHP_BIN" artisan "$@"; }`;

const SET_ENV = `
set_env() {
  if grep -q "^$1=" .env; then
    as_user sed -i "s#^$1=.*#$1=$2#" .env
  else
    if [ -n "$(tail -c1 .env)" ]; then printf '\\n' | as_user tee -a .env >/dev/null; fi
    printf '%s=%s\\n' "$1" "$2" | as_user tee -a .env >/dev/null
  fi
}`;

const NGINX_GUARD = `
CONF="/etc/nginx/sites-available/$DOMAIN.conf"
[ -f "$CONF" ] || { echo "The nginx config $CONF was not found." >&2; exit 1; }
SNIP_DIR="/etc/nginx/tylix-plugins/$DOMAIN"
SNIP="$SNIP_DIR/$PLUGIN.conf"
$SUDO mkdir -p "$SNIP_DIR"
if ! grep -qF "tylix-plugins/$DOMAIN/" "$CONF"; then
  $SUDO sed -i "/server_name /a include /etc/nginx/tylix-plugins/$DOMAIN/*.conf;" "$CONF"
fi`;

const writeSnippet = (content: string) => `
cat <<'SNIP_CONF' | $SUDO tee "$SNIP" >/dev/null
${content}
SNIP_CONF`;

const testReload = (revert = "") => `
if ! $SUDO nginx -t >/dev/null 2>&1; then
  $SUDO nginx -t 2>&1 || true
  $SUDO rm -f "$SNIP"
${revert}
  echo "nginx rejected the change, so it was rolled back." >&2
  exit 1
fi
$SUDO systemctl reload nginx
echo "nginx reloaded"`;

const removeSnippet = (extra = "") => `
SNIP="/etc/nginx/tylix-plugins/$DOMAIN/$PLUGIN.conf"
$SUDO rm -f "$SNIP"
${extra}
if command -v nginx >/dev/null 2>&1; then
  if $SUDO nginx -t >/dev/null 2>&1; then
    $SUDO systemctl reload nginx
    echo "nginx reloaded"
  else
    $SUDO nginx -t 2>&1 || true
    echo "nginx config test failed after removing the plugin." >&2
    exit 1
  fi
fi`;

const unitScript = (o: { unit: string; description: string; workdir: string; exec: string; reload?: string; env?: string[] }) => `
UNIT="${o.unit}"
cat <<UNIT_CONF | $SUDO tee "/etc/systemd/system/$UNIT.service" >/dev/null
[Unit]
Description=${o.description}
After=network.target

[Service]
Type=simple
User=$SITE_USER
WorkingDirectory=${o.workdir}
ExecStart=${o.exec}
${o.reload ? `ExecReload=${o.reload}` : ""}
Restart=always
RestartSec=3
${(o.env ?? []).map((e) => `Environment=${e}`).join("\n")}

[Install]
WantedBy=multi-user.target
UNIT_CONF
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$UNIT" >/dev/null 2>&1
$SUDO systemctl restart "$UNIT"
sleep 3
if $SUDO systemctl is-active --quiet "$UNIT"; then
  echo "Service $UNIT is running"
else
  echo "The service $UNIT did not stay up. Last log lines:" >&2
  $SUDO journalctl -u "$UNIT" -n 20 --no-pager >&2 || true
  exit 1
fi`;

const removeUnit = (unit: string) => `
UNIT="${unit}"
if [ -f "/etc/systemd/system/$UNIT.service" ]; then
  $SUDO systemctl stop "$UNIT" >/dev/null 2>&1 || true
  $SUDO systemctl disable "$UNIT" >/dev/null 2>&1 || true
  $SUDO rm -f "/etc/systemd/system/$UNIT.service"
  $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
  $SUDO systemctl reset-failed >/dev/null 2>&1 || true
  echo "Removed service $UNIT"
fi`;

const WS_HEADERS = `proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Scheme $scheme;
    proxy_set_header SERVER_PORT $server_port;
    proxy_set_header REMOTE_ADDR $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";`;

const isHttps = (site: PluginSite) =>
    (site.ssl_mode === "letsencrypt" || site.ssl_mode === "custom") && site.ssl_status === "active";

// --------------------------------------------------------------- Laravel

const OCTANE_TRY = `'s#try_files $uri $uri/ /index.php?$query_string;#try_files $uri $uri/ @octane;#'`;
const OCTANE_UNDO = `'s#try_files $uri $uri/ @octane;#try_files $uri $uri/ /index.php?$query_string;#'`;

const octane: PluginDef = {
    id: "octane",
    name: "Laravel Octane",
    group: "Laravel",
    description: "Keeps the app in memory with RoadRunner for much faster responses. nginx proxies to it instead of PHP-FPM.",
    types: ["laravel"],
    needsRepo: true,
    port: { start: 8000 },
    envKeys: "^OCTANE_",
    notes: [
        "Adds laravel/octane and RoadRunner to composer.json and composer.lock on the server. Commit those to your repository, or the next git pull may conflict.",
        "The deployer reloads the Octane service after every deploy.",
    ],
    install: ({ port }) => `${LARAVEL_PREP}
if ! grep -q '"laravel/octane"' composer.json || ! grep -q '"spiral/roadrunner-cli"' composer.json; then
  echo "--- composer require laravel/octane (roadrunner-http ^3, roadrunner-cli ^2)"
  composer_run require laravel/octane "spiral/roadrunner-http:^3.3" "spiral/roadrunner-cli:^2.6" --no-interaction --with-all-dependencies
  echo "NOTE: composer.json and composer.lock changed on the server. Commit them to your repository."
fi
echo "--- package:discover"
artisan package:discover
echo "--- octane:install"
artisan octane:install --server=roadrunner --no-interaction
if [ ! -x ./rr ]; then
  as_user ./vendor/bin/rr get-binary --no-interaction || true
fi
[ -x ./rr ] || { echo "The RoadRunner binary (./rr) was not downloaded. Run ./vendor/bin/rr get-binary in the site folder, then retry." >&2; exit 1; }
echo "--- service"
${unitScript({
    unit: "octane-$SITE_USER",
    description: "Laravel Octane ($DOMAIN)",
    workdir: "$SITE_ROOT",
    exec: "$PHP_BIN artisan octane:start --server=roadrunner --host=127.0.0.1 --port=$PORT --rpc-port=$RPC_PORT",
    reload: "$PHP_BIN artisan octane:reload",
})}
echo "--- nginx"
${NGINX_GUARD}
if grep -qF 'try_files $uri $uri/ /index.php?$query_string;' "$CONF"; then
  $SUDO sed -i ${OCTANE_TRY} "$CONF"
elif ! grep -qF '@octane' "$CONF"; then
  echo "The nginx config doesn't contain the standard Laravel try_files line, so it was not changed." >&2
  exit 1
fi
${writeSnippet(`location = /index.php {
    try_files /not_exists @octane;
}

location @octane {
    set $suffix "";
    if ($uri = /index.php) {
        set $suffix ?$query_string;
    }
    ${WS_HEADERS}
    proxy_pass http://127.0.0.1:${port}$suffix;
}`)}
${testReload(`  $SUDO sed -i ${OCTANE_UNDO} "$CONF"`)}`,
    uninstall: () => `
CONF="/etc/nginx/sites-available/$DOMAIN.conf"
if [ -f "$CONF" ]; then
  $SUDO sed -i ${OCTANE_UNDO} "$CONF"
fi
${removeSnippet()}
${removeUnit("octane-$SITE_USER")}
echo "Octane removed. The laravel/octane package is still in composer.json; remove it from your repository if you no longer want it."`,
};

const reverb: PluginDef = {
    id: "reverb",
    name: "Laravel Reverb",
    group: "Laravel",
    description: "First-party WebSocket server for broadcasting. Runs as a service and is proxied by nginx under /app and /apps.",
    types: ["laravel"],
    needsRepo: true,
    port: { start: 8080 },
    envKeys: "^(BROADCAST_CONNECTION|REVERB_|VITE_REVERB_)",
    notes: [
        "Needs Laravel 11 or newer. Adds laravel/reverb to composer.json and composer.lock on the server (and may touch package.json). Commit those changes.",
        "The REVERB_* values are written to the server .env and copied into the saved Deployment env, so a redeploy does not wipe them.",
        "Your front end still needs laravel-echo and pusher-js, and a rebuild after the keys exist.",
    ],
    install: ({ site, port }) => `${LARAVEL_PREP}
${SET_ENV}
if ! grep -q '"laravel/reverb"' composer.json; then
  echo "--- composer require laravel/reverb"
  composer_run require laravel/reverb --no-interaction --with-all-dependencies
  echo "NOTE: composer.json and composer.lock changed on the server. Commit them to your repository."
fi
echo "--- package:discover"
artisan package:discover
echo "--- reverb:install"
artisan reverb:install --no-interaction
set_env BROADCAST_CONNECTION reverb
set_env REVERB_HOST "$DOMAIN"
set_env REVERB_PORT ${isHttps(site) ? "443" : "80"}
set_env REVERB_SCHEME ${isHttps(site) ? "https" : "http"}
set_env REVERB_SERVER_HOST 127.0.0.1
set_env REVERB_SERVER_PORT "$PORT"
echo "--- service"
${unitScript({
    unit: "reverb-$SITE_USER",
    description: "Laravel Reverb ($DOMAIN)",
    workdir: "$SITE_ROOT",
    exec: "$PHP_BIN artisan reverb:start --host=127.0.0.1 --port=$PORT",
    env: ["APP_ENV=production"],
})}
echo "--- nginx"
${NGINX_GUARD}
${writeSnippet(`location /app/ {
    ${WS_HEADERS}
    proxy_read_timeout 3600s;
    proxy_pass http://127.0.0.1:${port};
}

location /apps/ {
    ${WS_HEADERS}
    proxy_pass http://127.0.0.1:${port};
}`)}
${testReload()}`,
    uninstall: () => `
${removeSnippet()}
${removeUnit("reverb-$SITE_USER")}
echo "Reverb removed. The laravel/reverb package and the REVERB_* env values are still there; remove them if you no longer want them."`,
};

// ----------------------------------------------------------------- Tylix

const tylixQueue: PluginDef = {
    id: "tylix-queue",
    name: "Queue worker",
    group: "Tylix",
    description: "Runs `npx tylix queue:work` as a service that restarts itself if it crashes.",
    types: ["tylix"],
    needsRepo: true,
    notes: ["The worker has no timeout, retry or crash recovery of its own. systemd restarts it, but running jobs are lost."],
    install: () => `
WORK="$SITE_ROOT"
if [ -n "$APP_DIR" ]; then WORK="$SITE_ROOT/$APP_DIR"; fi
[ -d "$WORK" ] || { echo "Folder '$APP_DIR' was not found in the repository." >&2; exit 1; }
[ -f "$WORK/package.json" ] || { echo "There is no package.json in $WORK." >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "Node.js/npx is not installed on this server." >&2; exit 1; }
RUNNER="/home/$SITE_USER/.queue-$SITE_USER.sh"
cat <<RUNNER_BODY | $SUDO tee "$RUNNER" >/dev/null
#!/bin/bash
cd '$WORK' || exit 1
exec npx tylix queue:work
RUNNER_BODY
$SUDO chown "$SITE_USER:$SITE_USER" "$RUNNER"
$SUDO chmod 750 "$RUNNER"
${unitScript({
    unit: "tylix-queue-$SITE_USER",
    description: "Tylix queue worker ($DOMAIN)",
    workdir: "$WORK",
    exec: "/bin/bash $RUNNER",
    env: ["NODE_ENV=production"],
})}`,
    uninstall: () => `
${removeUnit("tylix-queue-$SITE_USER")}
$SUDO rm -f "/home/$SITE_USER/.queue-$SITE_USER.sh"`,
};

// ------------------------------------------------------ nginx (all types)

const compression: PluginDef = {
    id: "compression",
    name: "Compression",
    group: "Web server",
    description: "gzip for text, JSON, JavaScript, CSS and SVG responses.",
    types: ALL,
    needsRepo: false,
    notes: [],
    install: () => `${NGINX_GUARD}
${writeSnippet(`gzip on;
gzip_comp_level 5;
gzip_min_length 256;
gzip_proxied any;
gzip_vary on;
gzip_types text/plain text/css text/xml application/json application/javascript application/xml application/rss+xml image/svg+xml font/ttf font/otf application/wasm;`)}
${testReload()}`,
    uninstall: () => removeSnippet(),
};

const securityHeaders: PluginDef = {
    id: "security-headers",
    name: "Security headers",
    group: "Web server",
    description: "Adds X-Content-Type-Options, X-Frame-Options and Referrer-Policy to every response.",
    types: ALL,
    needsRepo: false,
    notes: ["HSTS is not included. Turn it on separately once HTTPS is working and you are sure you want it."],
    install: () => `${NGINX_GUARD}
${writeSnippet(`add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;`)}
${testReload()}`,
    uninstall: () => removeSnippet(),
};

const rateLimit: PluginDef = {
    id: "rate-limit",
    name: "Rate limiting",
    group: "Web server",
    description: "Limits each visitor IP to about 20 requests per second (bursts of 60), answering 429 beyond that.",
    types: ALL,
    needsRepo: false,
    notes: ["Applies to the whole site, including assets. Visitors behind one shared IP count as one visitor."],
    install: ({ site }) => `${NGINX_GUARD}
HTTP_CONF="/etc/nginx/conf.d/tylix-$SITE_USER-ratelimit.conf"
cat <<'HTTP_BODY' | $SUDO tee "$HTTP_CONF" >/dev/null
limit_req_zone $binary_remote_addr zone=rl_${site.isolated_user}:10m rate=20r/s;
HTTP_BODY
${writeSnippet(`limit_req zone=rl_${site.isolated_user} burst=60 nodelay;
limit_req_status 429;`)}
${testReload(`  $SUDO rm -f "$HTTP_CONF"`)}`,
    uninstall: () => removeSnippet(`$SUDO rm -f "/etc/nginx/conf.d/tylix-$SITE_USER-ratelimit.conf"`),
};

const assetCache: PluginDef = {
    id: "asset-cache",
    name: "Asset caching",
    group: "Web server",
    description: "Tells browsers to cache CSS, JS, fonts and images for 30 days.",
    types: NGINX_SERVED,
    needsRepo: false,
    notes: ["Only enable this if your build output uses hashed file names, otherwise visitors can see stale files after a deploy."],
    install: () => `${NGINX_GUARD}
${writeSnippet(`location ~* ^/(?!api/).+\\.(?:css|js|mjs|map|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|ico)$ {
    try_files $uri =404;
    expires 30d;
    add_header Cache-Control "public";
    access_log off;
}`)}
${testReload()}`,
    uninstall: () => removeSnippet(),
};

// ---------------------------------------------------------------- more plugins

const NODE_TYPES = ["nodejs", "nextjs", "tylix", "mern"];

const scheduler: PluginDef = {
    id: "scheduler",
    name: "Task scheduler",
    group: "Laravel",
    description: "Adds the cron entry that runs php artisan schedule:run every minute as the site's user.",
    types: ["laravel"],
    needsRepo: true,
    notes: ["Adds one line marked # tylix-scheduler to the site user's crontab. Other crontab lines are left alone."],
    install: () => `
[ -f "$SITE_ROOT/artisan" ] || { echo "There is no artisan file in $SITE_ROOT. Is this a Laravel app?" >&2; exit 1; }
PHP_BIN="$(command -v "php$PHP_VERSION")" || { echo "PHP $PHP_VERSION is not installed on this server." >&2; exit 1; }
LINE="* * * * * cd $SITE_ROOT && $PHP_BIN artisan schedule:run >> /dev/null 2>&1 # tylix-scheduler"
( $SUDO crontab -u "$SITE_USER" -l 2>/dev/null | grep -v '# tylix-scheduler' || true; echo "$LINE" ) | $SUDO crontab -u "$SITE_USER" -
echo "Scheduler installed"`,
    uninstall: () => `
if $SUDO crontab -u "$SITE_USER" -l >/dev/null 2>&1; then
  $SUDO crontab -u "$SITE_USER" -l | grep -v '# tylix-scheduler' | $SUDO crontab -u "$SITE_USER" - || true
fi
echo "Scheduler removed"`,
};

const resourceLimits: PluginDef = {
    id: "resource-limits",
    name: "Resource limits",
    group: "Node.js",
    description: "Caps the app at 768 MB of memory and raises its open-file limit, so one runaway site can't take the server down.",
    types: NODE_TYPES,
    needsRepo: false,
    notes: ["Restarts the app once to apply. If the app goes over the cap, systemd kills it and restarts it."],
    install: () => `
UNIT="app-$SITE_USER"
[ -f "/etc/systemd/system/$UNIT.service" ] || { echo "The app service $UNIT does not exist yet. Deploy the site once, then install this plugin." >&2; exit 1; }
DROP="/etc/systemd/system/$UNIT.service.d"
$SUDO mkdir -p "$DROP"
cat <<'LIMITS_CONF' | $SUDO tee "$DROP/tylix-limits.conf" >/dev/null
[Service]
MemoryMax=768M
LimitNOFILE=65535
LIMITS_CONF
$SUDO systemctl daemon-reload
$SUDO systemctl restart "$UNIT"
sleep 3
if $SUDO systemctl is-active --quiet "$UNIT"; then
  echo "$UNIT is running with the new limits"
else
  $SUDO journalctl -u "$UNIT" -n 15 --no-pager || true
  echo "The app did not stay up with the new limits." >&2
  exit 1
fi`,
    uninstall: () => `
UNIT="app-$SITE_USER"
DROP="/etc/systemd/system/$UNIT.service.d"
$SUDO rm -f "$DROP/tylix-limits.conf"
$SUDO rmdir "$DROP" 2>/dev/null || true
$SUDO systemctl daemon-reload
if [ -f "/etc/systemd/system/$UNIT.service" ]; then $SUDO systemctl restart "$UNIT"; fi
echo "Limits removed"`,
};

const nextStatic: PluginDef = {
    id: "next-static",
    name: "Static asset caching",
    group: "Next.js",
    description: "Serves /_next/static with a one-year immutable cache header. Next.js hashes these file names, so it is safe.",
    types: ["nextjs"],
    needsRepo: false,
    notes: [],
    install: ({ site }) => `${NGINX_GUARD}
${writeSnippet(`location ^~ /_next/static/ {
    proxy_pass http://127.0.0.1:${Number(site.port)};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    expires 365d;
    add_header Cache-Control "public, max-age=31536000, immutable";
}`)}
${testReload()}`,
    uninstall: () => removeSnippet(),
};

const wwwRedirect: PluginDef = {
    id: "www-redirect",
    name: "Redirect www to non-www",
    group: "Web server",
    description: "Sends www.<domain> to <domain> with a permanent redirect.",
    types: ALL,
    needsRepo: false,
    notes: ["Add www.<domain> as an alias first, and make sure your certificate covers it."],
    install: ({ site }) => `${site.domain.startsWith("www.") ? `echo "This site's domain already starts with www." >&2; exit 1` : ""}
${NGINX_GUARD}
${writeSnippet(`if ($host = www.${site.domain}) {
    return 301 $scheme://${site.domain}$request_uri;
}`)}
${testReload()}`,
    uninstall: () => removeSnippet(),
};

const maintenance: PluginDef = {
    id: "maintenance",
    name: "Maintenance mode",
    group: "Web server",
    description: "Answers every request with a 503 and a short message while installed. Remove it to bring the site back.",
    types: ALL,
    needsRepo: false,
    notes: ["Takes the whole site offline, including the Let's Encrypt challenge. Renewals retry by themselves."],
    install: () => `${NGINX_GUARD}
${writeSnippet(`error_page 503 @maintenance;

location @maintenance {
    default_type text/html;
    add_header Retry-After 600 always;
    return 503 "<h1>Down for maintenance</h1><p>We will be back shortly.</p>";
}

return 503;`)}
${testReload()}`,
    uninstall: () => removeSnippet(),
};

export const CATALOG: PluginDef[] = [
    octane, reverb, scheduler,
    tylixQueue,
    resourceLimits, nextStatic,
    compression, securityHeaders, rateLimit, assetCache, wwwRedirect, maintenance,
];

export function getPlugin(id: string): PluginDef | undefined {
    return CATALOG.find((p) => p.id === id);
}

export function pluginsFor(type: string): PluginDef[] {
    return CATALOG.filter((p) => p.types.includes(type));
}

export function publicPlugin(def: PluginDef) {
    return {
        id: def.id,
        name: def.name,
        group: def.group,
        description: def.description,
        notes: def.notes,
        needs_repo: def.needsRepo,
    };
}