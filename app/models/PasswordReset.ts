import { Model } from "@tylix/orm";
import { createHash, randomBytes } from "node:crypto";

const RESET_TOKEN_TTL_SECONDS = 60 * 60;

export interface PasswordResetAttributes {
    id: number;
    email: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class PasswordReset extends Model {
    static table = "password_resets";

    static fillable: string[] = ["email", "token_hash", "expires_at", "used_at"];

    static hash(rawToken: string): string {
        return createHash("sha256").update(rawToken).digest("hex");
    }

    static async issue(email: string) {
        const rawToken = randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000);

        await this.create({
            email,
            token_hash: this.hash(rawToken),
            expires_at: expiresAt.toISOString(),
            used_at: null,
        });

        return { rawToken, expiresAt };
    }

    static async findValid(rawToken: string, email: string): Promise<PasswordResetAttributes | null> {
        const tokenHash = this.hash(rawToken);
        const all = (await this.all()) as PasswordResetAttributes[];
        const record = all.find((r) => r.token_hash === tokenHash && r.email === email);

        if (!record) return null;
        if (record.used_at) return null;
        if (new Date(record.expires_at).getTime() < Date.now()) return null;

        return record;
    }

    static async markUsed(id: number) {
        return this.update(id, { used_at: new Date().toISOString() });
    }
}