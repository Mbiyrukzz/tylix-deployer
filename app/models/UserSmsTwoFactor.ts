import { Model } from "@tylix/orm";

/**
 * Table: user_sms_two_factors  (one row per user)
 *
 *   id                      increments / primary key
 *   user_id                 integer, unique, indexed
 *   phone                   string(20), default ""      digits only, e.g. 254712345678
 *   confirmed_at            datetime, nullable          null until the setup code is verified
 *   code_hash               string(64), nullable        sha256 of the pending code
 *   code_expires_at         datetime, nullable
 *   code_attempts           integer, default 0
 *   last_sent_at            datetime, nullable          drives the 60 s resend cooldown
 *   send_window_started_at  datetime, nullable          drives the hourly cap
 *   send_count              integer, default 0
 *   created_at / updated_at
 */
export interface UserSmsTwoFactorAttributes {
    id: number;
    user_id: number;
    phone: string;
    confirmed_at: string | null;
    code_hash: string | null;
    code_expires_at: string | null;
    code_attempts: number;
    last_sent_at: string | null;
    send_window_started_at: string | null;
    send_count: number;
    created_at: string;
    updated_at: string;
}

export class UserSmsTwoFactor extends Model {
    static table = "user_sms_two_factors";
    static fillable: (keyof UserSmsTwoFactorAttributes)[] = [
        "user_id",
        "phone",
        "confirmed_at",
        "code_hash",
        "code_expires_at",
        "code_attempts",
        "last_sent_at",
        "send_window_started_at",
        "send_count",
    ];
}