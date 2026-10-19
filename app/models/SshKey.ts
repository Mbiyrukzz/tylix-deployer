import { Model } from "@tylix/orm";

export interface SshKeyAttributes {
    id: number;
    user_id: number;
    team_id: number;
    name: string;
    public_key: string;
    fingerprint: string;
    created_at: string;
    updated_at: string;
}

export class SshKey extends Model {
    static table = "ssh_keys";
    static fillable: (keyof SshKeyAttributes)[] = ["user_id", "team_id", "name", "public_key", "fingerprint"];
}