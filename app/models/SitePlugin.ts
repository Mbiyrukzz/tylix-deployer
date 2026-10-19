import { Model } from "@tylix/orm";

export interface SitePluginAttributes {
    id: number;
    user_id: number;
    team_id: number;
    site_id: number;
    server_id: number;
    plugin: string;
    status: string;
    step: string;
    error: string;
    log: string;
    config: string;
    installed_at: string;
    created_at: string;
    updated_at: string;
}

export class SitePlugin extends Model {
    static table = "site_plugins";
    static fillable: (keyof SitePluginAttributes)[] = [
        "user_id",
        "team_id",
        "site_id",
        "server_id",
        "plugin",
        "status",
        "step",
        "error",
        "log",
        "config",
        "installed_at",
    ];
}