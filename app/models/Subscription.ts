import { Model } from "@tylix/orm";

export interface SubscriptionAttributes {
    id: number;
    team_id: number;
    plan: string;
    status: string;
    billing_interval: string;
    paystack_customer_code: string;
    paystack_subscription_code: string;
    paystack_email_token: string;
    current_period_end: string;
    cancel_at_period_end: number;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class Subscription extends Model {
    static table = "subscriptions";

    static fillable: string[] = [
        "team_id",
        "plan",
        "status",
        "billing_interval",
        "paystack_customer_code",
        "paystack_subscription_code",
        "paystack_email_token",
        "current_period_end",
        "cancel_at_period_end",
    ];
}