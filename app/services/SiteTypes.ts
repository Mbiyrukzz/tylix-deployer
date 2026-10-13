/**
 * The site types the deployer can create. One place for labels, defaults and
 * runtime kind, so the validator, controller, provisioner and the create form
 * (via GET /api/site-types) all agree.
 *
 *   php     PHP-FPM pool per site (laravel, php, wordpress)
 *   node    one Node process behind an nginx proxy (tylix, nextjs, nodejs)
 *   mern    React build served by nginx + Node API on a port, /api proxied
 *   static  files served by nginx, optionally built first (angular, static)
 */

export type Runtime = "php" | "node" | "mern" | "static";

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

export const PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4"];

export function getType(id: string): SiteTypeInfo | undefined {
    return SITE_TYPES.find((t) => t.id === id);
}

export const isPhp = (id: string) => getType(id)?.runtime === "php";

/** Types that run a Node process on a port. */
export const needsPort = (id: string) => {
    const runtime = getType(id)?.runtime;
    return runtime === "node" || runtime === "mern";
};