import { Model } from "@tylix/orm";

export interface TeamAttributes {
    id: number;
    name: string;
    slug: string;
    owner_id: number;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class Team extends Model {
    static table = "teams";

    static fillable: string[] = ["name", "slug", "owner_id"];

    static async find(id: number | string): Promise<TeamAttributes | null> {
        return (await super.find(id)) as TeamAttributes | null;
    }

    static async create(data: Record<string, unknown>): Promise<TeamAttributes | null> {
        return (await super.create(data)) as TeamAttributes | null;
    }
}