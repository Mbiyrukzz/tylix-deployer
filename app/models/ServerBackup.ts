import { Model } from "@tylix/orm";

export interface ServerBackupAttributes {
    id: number;
    user_id: number;
    team_id: number;
    server_id: number;
    name: string;
   db_names: string;
    storage_id: number;
    schedule: string;
    retention: number;
    created_at: string;
    updated_at: string;
}

export class ServerBackup extends Model {
static table = "server_backups";
static fillable: (keyof ServerBackupAttributes)[] = [
"user_id",
"team_id",
"server_id",
"name",
"db_names",
"storage_id",
"schedule",
"retention",
];
}
