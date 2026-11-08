import { Model } from "@tylix/orm";

export interface DeploymentAttributes {
    id: number;
    site_id: number;
    user_id: number;
    team_id: number;
    status: string;
    log: string;
    branch: string;
    commit_sha: string;
    commit_message: string;
    started_at: string;
    finished_at: string;
    created_at: string;
    updated_at: string;
}

export class Deployment extends Model {
    static table = "deployments";
    static fillable: (keyof DeploymentAttributes)[] = [
        "site_id",
        "user_id",
        "team_id",
        "status",
        "log",
        "branch",
        "commit_sha",
        "commit_message",
        "started_at",
        "finished_at",
    ];
}