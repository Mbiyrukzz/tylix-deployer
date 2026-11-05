/**
 * Documentation content. Public, no login needed.
 *
 * GET /api/docs   [{ id, title, summary, blocks }]  every section, in order
 *
 * The page is app/pages/Docs.tyx (/docs). It renders whatever this returns,
 * so to change the docs, edit the sections below.
 *
 * Block kinds: "h" heading, "p" paragraph, "li" list item,
 * "code" code sample, "note" highlighted tip.
 */

import type { Router } from "@tylix/core";

type Block = { kind: "h" | "p" | "li" | "code" | "note"; text: string };
type Section = { id: string; title: string; summary: string; blocks: Block[] };

const DOCS: Section[] = [
    {
        id: "getting-started",
        title: "Getting started",
        summary: "From an empty account to your first live site.",
        blocks: [
            {
                kind: "p",
                text: "Tylix Deploy connects to your servers, creates sites on them, deploys your code and sets up SSL. There are three steps to your first live site.",
            },
            { kind: "li", text: "Connect a server. Provision one at a cloud provider, or connect your own over SSH." },
            { kind: "li", text: "Create a site. Pick a framework, a repository and a domain." },
            { kind: "li", text: "Deploy and add SSL. Run the deploy script, then enable Let's Encrypt." },
            {
                kind: "note",
                text: "The dashboard shows a Get deployed checklist that ticks each step off as you finish it.",
            },
        ],
    },
    {
        id: "providers",
        title: "Cloud providers",
        summary: "Create servers from Linode, Hetzner, DigitalOcean, Vultr or UpCloud.",
        blocks: [
            {
                kind: "p",
                text: "Connect a provider account with an API token and Tylix Deploy can create servers there for you.",
            },
            { kind: "h", text: "Supported providers" },
            { kind: "li", text: "Linode (Akamai)" },
            { kind: "li", text: "Hetzner Cloud" },
            { kind: "li", text: "DigitalOcean" },
            { kind: "li", text: "Vultr" },
            { kind: "li", text: "UpCloud" },
            { kind: "h", text: "Already have a server?" },
            {
                kind: "p",
                text: "Use the Custom server option to connect any machine you can reach over SSH, whichever company hosts it.",
            },
            {
                kind: "p",
                text: "After you create a server, you are taken to its page, where the provisioning steps and a percentage update live.",
            },
        ],
    },
    {
        id: "servers",
        title: "Servers",
        summary: "Connect, monitor and prepare your servers.",
        blocks: [
            {
                kind: "p",
                text: "Every server shows its SSH address and a status: Online, Offline, or Not tested if the connection has not been checked yet.",
            },
            { kind: "h", text: "Server packages" },
            {
                kind: "p",
                text: "The Server Packages page installs software such as web servers and runtimes over SSH, so a fresh server is ready for sites.",
            },
            { kind: "h", text: "Logs" },
            {
                kind: "p",
                text: "Server events such as provisions and reboots are recorded and listed on the logs page.",
            },
            { kind: "h", text: "Root password" },
            {
                kind: "p",
                text: "The root password of a server you created is hidden behind two-factor confirmation, in a popup on the Servers page.",
            },
        ],
    },
    {
        id: "sites",
        title: "Sites",
        summary: "Create, deploy and secure sites.",
        blocks: [
            { kind: "p", text: "A site belongs to a server. Choose a framework, a repository and a domain." },
            { kind: "h", text: "Frameworks" },
            {
                kind: "p",
                text: "Tylix, Laravel, PHP, Node.js, Next.js, WordPress, MERN, Angular, FastAPI, Django, Java, Go, Ruby, .NET, Rust and Static.",
            },
            { kind: "h", text: "Site status" },
            { kind: "li", text: "Queued: waiting to start." },
            { kind: "li", text: "Creating: being set up on the server." },
            { kind: "li", text: "Ready: live." },
            { kind: "li", text: "Failed: open the site to read the deployment log." },
            { kind: "h", text: "SSL" },
            { kind: "p", text: "Once the domain points at the server, enable Let's Encrypt from the site page." },
        ],
    },
    {
        id: "domains",
        title: "Domains and registrars",
        summary: "See every domain and when it expires.",
        blocks: [
            {
                kind: "p",
                text: "Connect a registrar and its domains appear on your dashboard next to your servers, closest to expiry first.",
            },
            { kind: "h", text: "Supported registrars" },
            {
                kind: "p",
                text: "Porkbun, Cloudflare, GoDaddy, Namecheap, Name.com, Dynadot, Route 53 Domains and Spaceship.",
            },
            {
                kind: "note",
                text: "A domain that expires within 30 days, or has already expired, is flagged under Needs attention on the dashboard.",
            },
        ],
    },
    {
        id: "team",
        title: "Team",
        summary: "Work on the same servers and sites with other people.",
        blocks: [
            { kind: "p", text: "Invite people from the Team page. Each member has a role." },
            { kind: "li", text: "Owner: full control, including the team itself." },
            { kind: "li", text: "Admin: manages servers, sites and members." },
            { kind: "li", text: "Member: works on what the team shares." },
        ],
    },
    {
        id: "billing",
        title: "Plans and billing",
        summary: "How subscriptions and the locked state work.",
        blocks: [
            {
                kind: "p",
                text: "Subscriptions are paid through Paystack. When a subscription lapses, the account becomes view only: you can still look at everything, but creating servers and sites is disabled until you pay.",
            },
        ],
    },
];

export async function routes(router: Router) {
    router.get("/api/docs", async (_req, res) => {
        return res.json(DOCS);
    });
}