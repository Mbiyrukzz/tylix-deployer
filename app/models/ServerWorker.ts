import { Model } from "@tylix/orm";

export interface ServerWorkerAttributes {
    id: number;
    user_id: number;
    team_id: number;
    server_id: number;
    name: string;
    command: string;
    directory: string;
    ssh_user: string;
    processes: number;
    created_at: string;
    updated_at: string;
}

export class ServerWorker extends Model {
    static table = "server_workers";
    static fillable: (keyof ServerWorkerAttributes)[] = [
        "user_id",
        "team_id",
        "server_id",
        "name",
        "command",
        "directory",
        "ssh_user",
        "processes",
    ];
}