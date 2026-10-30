import { Model } from "@tylix/orm";
import { createHash, randomBytes } from "node:crypto";

const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface RefreshTokenAttributes {
    id: number;
    user_id: number;
    token_hash: string;
    expires_at: string;
    revoked_at: string | null;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class RefreshToken extends Model {
    static table = "refresh_tokens";

    static fillable: string[] = ["user_id", "token_hash", "expires_at", "revoked_at"];

    static hash(rawToken: string): string {
        return createHash("sha256").update(rawToken).digest("hex");
    }

    static async issue(userId: number) {
        const rawToken = randomBytes(48).toString("hex");
        const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

        await this.create({
            user_id: userId,
            token_hash: this.hash(rawToken),
            expires_at: expiresAt.toISOString(),
            revoked_at: null,
        });

        return { rawToken, expiresAt, ttlSeconds: REFRESH_TOKEN_TTL_SECONDS };
    }

    static async findValid(rawToken: string): Promise<RefreshTokenAttributes | null> {
        const record = (await this.query()
            .where("token_hash", this.hash(rawToken))
            .first()) as RefreshTokenAttributes | null;

        if (!record) return null;
        if (record.revoked_at) return null;
        if (new Date(record.expires_at).getTime() < Date.now()) return null;

        return record;
    }

    static async revoke(rawToken: string) {
        const record = await this.findValid(rawToken);
        if (!record) return;
        await this.update(record.id, { revoked_at: new Date().toISOString() });
    }

    static async revokeAllForUser(userId: number) {
        // Filtered by user in the database; the revoked check stays in code
        // because a NULL comparison isn't something I've seen the builder handle.
        const rows = (await this.query()
            .where("user_id", userId)
            .get()) as unknown as RefreshTokenAttributes[];
        const active = rows.filter((t) => !t.revoked_at);
        await Promise.all(
            active.map((t) => this.update(t.id, { revoked_at: new Date().toISOString() })),
        );
    }
}