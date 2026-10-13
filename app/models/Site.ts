import { Model } from "@tylix/orm";

export interface SiteAttributes {
    id: number;
    user_id: number;
    server_id: number;
    source_control_id: number;
    type: string;
    domain: string;
    aliases: string;
    isolated_user: string;
    php_version: string;
    port: number;
    repository: string;
    branch: string;
    web_directory: string;
    app_directory: string;
    backend_directory: string;
    build_command: string;
    start_command: string;
    install_deps: number;
    status: string;
    step: string;
    error: string;
    log: string;
    created_at: string;
    updated_at: string;
}

export class Site extends Model {
    static table = "sites";
    static fillable: (keyof SiteAttributes)[] = [
        "user_id",
        "server_id",
        "source_control_id",
        "type",
        "domain",
        "aliases",
        "isolated_user",
        "php_version",
        "port",
        "repository",
        "branch",
        "web_directory",
        "app_directory",
        "backend_directory",
        "build_command",
        "start_command",
        "install_deps",
        "status",
        "step",
        "error",
        "log",
    ];
}