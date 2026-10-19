import { Model } from "@tylix/orm";

export interface TeamMemberAttributes {
    id: number;
    team_id: number;
    user_id: number;
    role: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class TeamMember extends Model {
    static table = "team_members";

    static fillable: string[] = ["team_id", "user_id", "role"];
}