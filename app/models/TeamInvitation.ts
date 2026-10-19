import { Model } from "@tylix/orm";

export interface TeamInvitationAttributes {
    id: number;
    team_id: number;
    email: string;
    role: string;
    token_hash: string;
    invited_by: number;
    expires_at: string;
    accepted_at: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class TeamInvitation extends Model {
    static table = "team_invitations";

    static fillable: string[] = ["team_id", "email", "role", "token_hash", "invited_by", "expires_at", "accepted_at"];
}