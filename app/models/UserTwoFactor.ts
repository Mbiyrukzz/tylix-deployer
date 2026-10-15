import { Model } from "@tylix/orm";

export interface UserTwoFactorAttributes {
    id: number;
    user_id: number;
    secret: string;
    confirmed_at: string | null;
    recovery_codes: string;
    last_step: number;
    created_at: string;
    updated_at: string;
}

export class UserTwoFactor extends Model {
    static table = "user_two_factors";
    static fillable: (keyof UserTwoFactorAttributes)[] = [
        "user_id",
        "secret",
        "confirmed_at",
        "recovery_codes",
        "last_step",
    ];
}