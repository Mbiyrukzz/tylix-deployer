/**
 * The site types the deployer can create. One place for labels, defaults and
 * runtime kind, so the validator, controller, provisioner and the create form
 * (via GET /api/site-types) all agree.
 *
 *   php     PHP-FPM pool per site (laravel, php, wordpress)
 *   node    one Node process behind an nginx proxy (tylix, nextjs, nodejs)
 *   mern    React build served by nginx + Node API on a port, /api proxied
 *   static  files served by nginx, optionally built first (angular, static)
 *   python  virtualenv + gunicorn/uvicorn on a port behind an nginx proxy (fastapi, django)
 *   java    a built jar (Maven or Gradle) on a port behind an nginx proxy (java)
 *   go      a binary built with go build, on a port behind an nginx proxy (go)
 *   ruby    Bundler gems + puma (or any Rack server) on a port behind an nginx proxy (ruby)
 *   dotnet  dotnet publish output on a port behind an nginx proxy (dotnet)
 *   rust    a binary built with cargo build --release, on a port behind an nginx proxy (rust)
 */

export type Runtime = "php" | "node" | "mern" | "static" | "python" | "java" | "go" | "ruby" | "dotnet" | "rust";

export interface SiteTypeDefaults {
    web_directory: string;
    app_directory: string;
    backend_directory: string;
    build_command: string;
    start_command: string;
}

export interface SiteTypeInfo {
    id: string;
    label: string;
    description: string;
    runtime: Runtime;
    usesRepository: boolean;
    defaults: SiteTypeDefaults;
}

const blank: SiteTypeDefaults = {
    web_directory: "",
    app_directory: "",
    backend_directory: "",
    build_command: "",
    start_command: "",
};

const defaults = (over: Partial<SiteTypeDefaults>): SiteTypeDefaults => ({ ...blank, ...over });

export const SITE_TYPES: SiteTypeInfo[] = [
    {
        id: "tylix",
        label: "Tylix",
        description: "A Tylix app: built, then run as a service behind nginx.",
        runtime: "node",
        usesRepository: true,
        defaults: defaults({ build_command: "npm run build", start_command: "npm start" }),
    },
    {
        id: "laravel",
        label: "Laravel",
        description: "Laravel with its own PHP-FPM pool. Web root is public/.",
        runtime: "php",
        usesRepository: true,
        defaults: defaults({ web_directory: "public" }),
    },
    {
        id: "php",
        label: "PHP",
        description: "Plain PHP site with its own PHP-FPM pool.",
        runtime: "php",
        usesRepository: true,
        defaults: defaults({}),
    },
    {
        id: "nodejs",
        label: "Node.js (npm)",
        description: "Any Node app started with an npm script, proxied by nginx.",
        runtime: "node",
        usesRepository: true,
        defaults: defaults({ start_command: "npm start" }),
    },
    {
        id: "nextjs",
        label: "Next.js",
        description: "Next.js: built, then run as a service behind nginx.",
        runtime: "node",
        usesRepository: true,
        defaults: defaults({ build_command: "npm run build", start_command: "npm start" }),
    },
    {
        id: "fastapi",
        label: "FastAPI",
        description: "FastAPI in its own virtualenv, run by uvicorn as a service behind nginx.",
        runtime: "python",
        usesRepository: true,
        defaults: defaults({
            start_command: ".venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT --proxy-headers --forwarded-allow-ips 127.0.0.1",
        }),
    },
    {
        id: "django",
        label: "Django",
        description: "Django in its own virtualenv, run by gunicorn behind nginx. nginx serves /static/ from STATIC_ROOT.",
        runtime: "python",
        usesRepository: true,
        defaults: defaults({
            web_directory: "staticfiles",
            build_command: ".venv/bin/python manage.py migrate --noinput && .venv/bin/python manage.py collectstatic --noinput",
            start_command: ".venv/bin/gunicorn config.wsgi:application --bind 127.0.0.1:$PORT --workers 3",
        }),
    },
    {
        id: "java",
        label: "Java API (Spring Boot)",
        description: "A Java API built with Maven or Gradle and run as a jar service behind nginx.",
        runtime: "java",
        usesRepository: true,
        defaults: defaults({
            start_command: "java -Xmx512m -jar target/*.jar --server.port=$PORT",
        }),
    },
    {
        id: "go",
        label: "Go",
        description: "A Go app built on the server with go build and run as a service behind nginx. Listen on $PORT.",
        runtime: "go",
        usesRepository: true,
        defaults: defaults({
            build_command: "go build -o app .",
            start_command: "./app",
        }),
    },
    {
        id: "ruby",
        label: "Ruby (Rails / Rack)",
        description: "A Ruby app with gems installed by Bundler, run by puma as a service behind nginx.",
        runtime: "ruby",
        usesRepository: true,
        defaults: defaults({
            start_command: "bundle exec puma -b tcp://127.0.0.1:$PORT -e production",
        }),
    },
    {
        id: "dotnet",
        label: ".NET (ASP.NET Core)",
        description: "An ASP.NET Core app published with dotnet publish and run as a service behind nginx.",
        runtime: "dotnet",
        usesRepository: true,
        defaults: defaults({
            build_command: "dotnet publish -c Release -o publish",
            start_command: "dotnet publish/YourApp.dll --urls http://127.0.0.1:$PORT",
        }),
    },
    {
        id: "rust",
        label: "Rust",
        description: "A Rust app built with cargo build --release and run as a service behind nginx. Listen on $PORT.",
        runtime: "rust",
        usesRepository: true,
        defaults: defaults({
            build_command: "cargo build --release",
            start_command: "./target/release/your-app",
        }),
    },
    {
        id: "wordpress",
        label: "WordPress",
        description: "Downloads the latest WordPress and creates its database.",
        runtime: "php",
        usesRepository: false,
        defaults: defaults({}),
    },
    {
        id: "mern",
        label: "MERN",
        description: "React client (client/) served by nginx, Node API (server/) on a port.",
        runtime: "mern",
        usesRepository: true,
        defaults: defaults({
            app_directory: "client",
            backend_directory: "server",
            build_command: "npm run build",
            start_command: "npm start",
        }),
    },
    {
        id: "angular",
        label: "Angular",
        description: "Angular app built on the server and served as a single-page app.",
        runtime: "static",
        usesRepository: true,
        defaults: defaults({ build_command: "npm run build" }),
    },
    {
        id: "static",
        label: "Static HTML",
        description: "Plain files served by nginx.",
        runtime: "static",
        usesRepository: true,
        defaults: defaults({}),
    },
];

export const PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4", "8.5"];

/** Runtimes that run a process on a port behind an nginx proxy (mern's API included). */
const APP_RUNTIMES: Runtime[] = ["node", "mern", "python", "java", "go", "ruby", "dotnet", "rust"];

export function getType(id: string): SiteTypeInfo | undefined {
    return SITE_TYPES.find((t) => t.id === id);
}

export const isPhp = (id: string) => getType(id)?.runtime === "php";

export const isPython = (id: string) => getType(id)?.runtime === "python";

export const isJava = (id: string) => getType(id)?.runtime === "java";

export const isAppRuntime = (runtime: Runtime) => APP_RUNTIMES.includes(runtime);

/** Types that run a process on a port (node, mern API, python, java, go, ruby, dotnet, rust). */
export const needsPort = (id: string) => {
    const runtime = getType(id)?.runtime;
    return runtime !== undefined && isAppRuntime(runtime);
};