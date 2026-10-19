import { Model } from "@tylix/orm";

export interface ServerCronJobAttributes {
    id: number;
    user_id: number;
    team_id: number;
    server_id: number;
    name: string;
    command: string;
    ssh_user: string;
    schedule: string;
    created_at: string;
    updated_at: string;
}

export class ServerCronJob extends Model {
static table = "server_cron_jobs";
static fillable: (keyof ServerCronJobAttributes)[] = [
"user_id",
"team_id",
"server_id",
"name",
"command",
"ssh_user",
"schedule",
];
}