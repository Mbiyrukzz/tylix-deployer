import { Model } from "@tylix/orm";

export interface UserAvatarAttributes {
    id: number;
    user_id: number;
    mime: string;
    hash: string;
    data: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

// A user's profile picture (one row per user). See
// database/migrations/20261119120000_create_user_avatars_table.ts.
export class UserAvatar extends Model {
    static table = "user_avatars";

    static fillable: string[] = ["user_id", "mime", "hash", "data"];

    static async forUser(userId: number): Promise<UserAvatarAttributes | null> {
        return (await this.query().where("user_id", userId).first()) as UserAvatarAttributes | null;
    }
}
