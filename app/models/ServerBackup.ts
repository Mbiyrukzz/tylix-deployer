import { Model } from "@tylix/orm";

export interface ServerBackupAttributes {
    id: number;
    user_id: number;
    server_id: number;
    name: string;
    databases: string;
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
"server_id",
"name",
"databases",
"storage_id",
"schedule",
"retention",
];
}
