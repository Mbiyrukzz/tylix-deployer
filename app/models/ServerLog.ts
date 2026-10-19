import { Model } from "@tylix/orm";

export interface ServerLogAttributes {
    id: number;
    user_id: number;
    team_id: number;
    server_id: number | null;
    provision_id: number | null;
    event: string;
    level: string;
    message: string;
    meta: string;
    created_at: string;
    updated_at: string;
}

export class ServerLog extends Model {
    static table = "server_logs";
    static fillable: (keyof ServerLogAttributes)[] = [
        "user_id",
        "team_id",
        "server_id",
        "provision_id",
        "event",
        "level",
        "message",
        "meta",
    ];
}