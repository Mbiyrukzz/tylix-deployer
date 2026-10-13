import pathlib

MAIN   = pathlib.Path("app/pages/components/Sidebar.tyx")
SERVER = pathlib.Path("app/pages/components/ServerSidebar.tyx")

# (active key, label, href, icon)
MAIN_ITEMS = [
    ("overview",       "Overview",       "/dashboard",      "IconHome"),
    ("servers",        "Servers",        "/servers",        "IconDatabase"),
    ("providers",      "Providers",      "/providers",      "IconFolder"),
    ("source-control", "Source control", "/source-control", "IconFolder"),
]

# (active key, label, page file name, built yet?)
SERVER_ITEMS = [
    ("server",     "Overview",  "server-detail",   True),
    ("database",   "Database",  "server-database", False),
    ("backups",    "Backups",   "server-backups",  False),
    ("sites",      "Sites",     "server-sites",    False),
    ("firewall",   "Firewall",  "server-firewall", False),
    ("cronjobs",   "CronJobs",  "server-cronjobs", False),
    ("workers",    "Workers",   "server-workers",  False),
    ("ssh-keys",   "SSH Keys",  "server-ssh-keys", False),
    ("services",   "Services",  "server-services", False),
    ("packages",   "Packages",  "server-packages", True),
    ("logs",       "Logs",      "server-logs",     False),
    ("settings",   "Settings",  "server-settings", False),
]

ON  = "shrink-0 flex items-center gap-2.5 px-3 py-2 rounded-xl bg-gradient-to-r from-emerald-500/15 to-transparent text-emerald-700 dark:text-emerald-400 text-sm font-medium"
OFF = "shrink-0 flex items-center gap-2.5 px-3 py-2 rounded-xl text-slate-600 dark:text-slate-400 text-sm hover:bg-slate-300/50 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
DIM = "shrink-0 flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-slate-400 dark:text-slate-600 text-sm cursor-not-allowed select-none"

def link(key, label, href, icon=""):
    ic = f'<{icon} class="w-4 h-4" /> ' if icon else ""
    return f'''{{{{#if active is "{key}"}}}}
    <a href="{href}" aria-current="page" class="{ON}">
      {ic}{label}
    </a>
{{{{/if}}}}
{{{{#if active is not "{key}"}}}}
    <a href="{href}" class="{OFF}">
      {ic}{label}
    </a>
{{{{/if}}}}
'''

def server_item(key, label, page, ready):
    if not ready:
        return f'''    <span class="{DIM}" aria-disabled="true" title="Coming soon">
      <span>{label}</span>
      <span class="text-[10px] font-semibold uppercase tracking-wider">Soon</span>
    </span>
'''
    return link(key, label, "{{ '/servers/" + page + "?id=' + serverId }}")

ASIDE = "flex lg:flex-col gap-1 overflow-x-auto lg:overflow-y-auto lg:overflow-x-visible border-b lg:border-b-0 lg:border-r border-slate-300 dark:border-slate-800 {bg} p-3 lg:p-5 lg:sticky lg:top-16 lg:self-start lg:h-[calc(100vh-4rem)]"

main = f'''component Sidebar

import {{ IconHome, IconDatabase, IconFolder }} from "tylix-icons"

props
  active: String

template
  <aside class="{ASIDE.format(bg="bg-slate-200 dark:bg-slate-950")}">
    <div class="hidden lg:flex items-center gap-2.5 mb-8 px-1">
      <div class="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center shadow-sm dark:shadow-emerald-500/30">
        <IconHome class="w-4 h-4 text-white" />
      </div>
      <span class="text-slate-800 dark:text-slate-200 font-semibold text-sm">tylix-deploy</span>
    </div>

{"".join(link(*i) for i in MAIN_ITEMS)}  </aside>
'''

server = f'''component ServerSidebar

props
  active: String
  serverId: String

template
  <aside class="{ASIDE.format(bg="bg-slate-300/30 dark:bg-slate-900/40")}">
    <p class="hidden lg:block text-slate-500 text-[11px] font-semibold uppercase tracking-wider mb-2 px-3">This server</p>
{"".join(server_item(*i) for i in SERVER_ITEMS)}  </aside>
'''

MAIN.write_text(main)
SERVER.write_text(server)
print("wrote", MAIN, "and", SERVER)
