import { Model } from "@tylix/orm";

export interface ServerSshKeyAttributes {
    id: number;
    user_id: number;
    team_id: number;
    server_id: number;
    ssh_key_id: number;
    ssh_user: string;
    created_at: string;
    updated_at: string;
}

export class ServerSshKey extends Model {
    static table = "server_ssh_keys";
    static fillable: (keyof ServerSshKeyAttributes)[] = ["user_id", "team_id", "server_id", "ssh_key_id", "ssh_user"];
}