import { Model } from "@tylix/orm";

/**
 * One row per activity entry a team has deleted.
 *
 * The activity feed is built from the rows members created (servers, sites,
 * deployments and so on), so deleting an entry here only hides it from the
 * feed. The server, site or connection itself is never touched.
 *
 * Table columns (see migrations/20261031120000_create_activity_dismissals_table.ts):
 *   id, team_id, event_id (string, e.g. "server:12"),
 *   dismissed_by (user id), created_at, updated_at
 *
 * Duplicates are prevented in ActivityFeedService.dismiss(), not by the database.
 */
export interface ActivityDismissalAttributes {
    id: number;
    team_id: number;
    event_id: string;
    dismissed_by: number;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class ActivityDismissal extends Model {
    static table = "activity_dismissals";

    static fillable: string[] = ["team_id", "event_id", "dismissed_by"];
}