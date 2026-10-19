
import { Model } from "@tylix/orm";

export interface ServerDatabaseAttributes {
    id: number;
    user_id: number;
    team_id: number;
    server_id: number;
    db_user_id: number;
    name: string;
    charset: string;
    collation: string;
    created_at: string;
    updated_at: string;
}

export class ServerDatabase extends Model {
    static table = "server_databases";
    static fillable: (keyof ServerDatabaseAttributes)[] = [
        "user_id",
        "team_id",
        "server_id",
        "db_user_id",
        "name",
        "charset",
        "collation",
    ];
}