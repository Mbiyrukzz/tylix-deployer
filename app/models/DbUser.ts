

import { Model } from "@tylix/orm";

export interface DbUserAttributes {
    id: number;
    user_id: number;
    server_id: number;
    name: string;
    host: string;
    password: string;
    created_at: string;
    updated_at: string;
}

export class DbUser extends Model {
    static table = "db_users";
    static fillable: (keyof DbUserAttributes)[] = [
        "user_id",
        "server_id",
        "name",
        "host",
        "password",
    ];
}

