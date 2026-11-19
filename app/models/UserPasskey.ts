import { Model } from "@tylix/orm";

/** One passkey (WebAuthn credential). See database/migrations/20261119150000_create_user_passkeys_table.ts. */
export interface UserPasskeyAttributes {
    id: number;
    user_id: number;
    credential_id: string;
    user_handle: string;
    public_key: string;
    algorithm: number;
    sign_count: number;
    name: string;
    transports: string;
    aaguid: string;
    backed_up: boolean | number;
    last_used_at: string | null;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class UserPasskey extends Model {
    static table = "user_passkeys";

    static fillable: string[] = [
        "user_id",
        "credential_id",
        "user_handle",
        "public_key",
        "algorithm",
        "sign_count",
        "name",
        "transports",
        "aaguid",
        "backed_up",
        "last_used_at",
    ];

    static async forUser(userId: number): Promise<UserPasskeyAttributes[]> {
        return (await this.query().where("user_id", userId).orderBy("id", "ASC").get()) as UserPasskeyAttributes[];
    }

    static async byCredential(credentialId: string): Promise<UserPasskeyAttributes | null> {
        return (await this.query().where("credential_id", credentialId).first()) as UserPasskeyAttributes | null;
    }
}
