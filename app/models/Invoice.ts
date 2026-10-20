import { Model } from "@tylix/orm";

export interface InvoiceAttributes {
    id: number;
    team_id: number;
    number: string;
    description: string;
    plan: string;
    amount: number;
    currency: string;
    status: string;
    due_date: string;
    paid_at: string;
    paystack_invoice_code: string;
    paystack_reference: string;
    created_at: string;
    updated_at: string;
}

export class Invoice extends Model {
    static table = "invoices";
    static fillable: (keyof InvoiceAttributes)[] = [
        "team_id",
        "number",
        "description",
        "plan",
        "amount",
        "currency",
        "status",
        "due_date",
        "paid_at",
        "paystack_invoice_code",
        "paystack_reference",
    ];
}