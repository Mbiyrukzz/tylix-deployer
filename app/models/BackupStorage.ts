import { Model } from "@tylix/orm";

export interface BackupStorageAttributes {
    id: number;
    user_id: number;
    name: string;
    provider: string;
    app_key: string;
    app_secret: string;
    refresh_token: string;
    created_at: string;
    updated_at: string;
}

export class BackupStorage extends Model {
static table = "backup_storages";
static fillable: (keyof BackupStorageAttributes)[] = [
"user_id",
"name",
"provider",
"app_key",
"app_secret",
"refresh_token",
];
}
