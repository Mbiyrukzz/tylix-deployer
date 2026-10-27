import { Model } from "@tylix/orm";

export interface ProviderPaymentAttributes {
    id: number;
    user_id: number;
    team_id: number;
    provider_id: number;
    kind: string;
    amount_cents: number;
    currency: string;
    method_id: number;
    method_label: string;
    payment_ref: string;
    status: string;
    message: string;
    started_at: string;
    created_at: string;
    updated_at: string;
}

export class ProviderPayment extends Model {
    static table = "provider_payments";
    static fillable: (keyof ProviderPaymentAttributes)[] = [
        "user_id",
        "team_id",
        "provider_id",
        "kind",
        "amount_cents",
        "currency",
        "method_id",
        "method_label",
        "payment_ref",
        "status",
        "message",
        "started_at",
    ];
}