import { Model } from "@tylix/orm";

export interface ServerFirewallRuleAttributes {
    id: number;
    user_id: number;
    team_id: number;
    server_id: number;
    name: string;
    type: string;
    source: string;
    protocol: string;
    port: string;
    status: string;
    error: string;
    created_at: string;
    updated_at: string;
}

export class ServerFirewallRule extends Model {
    static table = "server_firewall_rules";
    static fillable: (keyof ServerFirewallRuleAttributes)[] = [
        "user_id", "team_id", "server_id", "name", "type", "source",
        "protocol", "port", "status", "error",
    ];
}