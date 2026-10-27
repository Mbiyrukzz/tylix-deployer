/**
 * Service: ProviderBilling
 *
 * What the deployer can do about money, per provider.
 *
 *   "pay"  - the provider's API can charge a saved payment method, so the
 *            deployer can start a payment itself. Linode only, for now.
 *   "link" - no payment API (or not built yet): the UI shows a button that
 *            opens the provider's own billing page. Every other provider.
 *
 * Read-only readers (balance, invoices) for DigitalOcean, Vultr, AWS and
 * Contabo come later; until then they are "link" too.
 *
 * Safety rules that live here, so no route can skip them:
 *   - the amount is validated and capped (parseAmount)
 *   - the payment method must belong to the account being charged
 *   - a card needs its CVV, which is checked for shape and never stored or logged
 *   - a payment is never retried, and an unclear outcome (timeout, 5xx) raises
 *     PaymentOutcomeUnknownError instead of looking like a plain failure
 */

import { LinodeClient, LinodeError } from "./LinodeClient.js";

export type BillingMode = "pay" | "link";

/**
 * OUR safety cap for one payment started from the deployer. It is not Linode's
 * limit: Linode enforces its own minimum and maximum and its message is passed through.
 */
export const MAX_PAYMENT_USD = 1000;

/**
 * Whether credit cards can be charged from the deployer. A card payment needs
 * the CVV typed into our UI and sent through our server (never stored, never
 * logged). Set to false to allow only Google Pay and PayPal in-app and send card
 * payments to the provider's own billing page.
 */
export const ALLOW_CARD_PAYMENTS = true;

/** Where to pay by hand. Open these in a new tab; they are plain deep links. */
const CONSOLE_URLS: Record<string, string> = {
    linode: "https://cloud.linode.com/account/billing",
    hetzner: "https://accounts.hetzner.com/invoice",
    digitalocean: "https://cloud.digitalocean.com/account/billing",
    vultr: "https://my.vultr.com/billing/",
    aws: "https://console.aws.amazon.com/billing/home",
    upcloud: "https://hub.upcloud.com/account/billing",
    contabo: "https://my.contabo.com",
};

const PAYABLE = new Set(["linode"]);

export function billingModeOf(kind: string): BillingMode {
    return PAYABLE.has(kind) ? "pay" : "link";
}

export function billingConsoleUrl(kind: string): string {
    return CONSOLE_URLS[kind] ?? "";
}

/** The request was wrong (bad amount, unknown card, bad CVV). Safe to show the message as is. */
export class BillingInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BillingInputError";
    }
}

/**
 * The payment call did not come back cleanly (timeout, dropped connection, 5xx),
 * so it may or may not have gone through. Never retry blindly: check the
 * provider's payment history first.
 */
export class PaymentOutcomeUnknownError extends Error {
    constructor() {
        super(
            "We couldn't confirm whether the payment went through. Check the provider's billing page before trying again.",
        );
        this.name = "PaymentOutcomeUnknownError";
    }
}

export interface BillingSummary {
    currency: "USD";
    /** Signed: positive means owed, negative means credit. */
    balance: number;
    amountDue: number;
    credit: number;
    /** Charged this month, not invoiced yet. */
    uninvoiced: number;
}

export interface BillingInvoice {
    id: number;
    date: string;
    label: string;
    total: number;
}

export interface BillingMethod {
    id: number;
    /** "credit_card", "google_pay" or "paypal". */
    type: string;
    isDefault: boolean;
    /** For example "Visa ••4417". Never the full number. */
    label: string;
    /** True for cards: the user must type the CVV for each payment. */
    needsCvv: boolean;
    /** False when this method can't be charged from the deployer (cards, when ALLOW_CARD_PAYMENTS is off). */
    payable: boolean;
}

/** A payment that passed every check and is ready to be charged. Holds the CVV, so keep it short lived. */
export interface PreparedPayment {
    amount: number;
    methodId: number;
    methodLabel: string;
    cvv?: string;
}

export interface PaymentReceipt {
    id: number;
    date: string;
    amount: number;
    currency: "USD";
}

export interface ProviderBilling {
    kind: string;
    summary(): Promise<BillingSummary>;
    invoices(): Promise<BillingInvoice[]>;
    methods(): Promise<BillingMethod[]>;
    /** Checks everything that can be checked without charging. Throws BillingInputError. */
    prepare(amount: unknown, methodId: unknown, cvv?: unknown): Promise<PreparedPayment>;
    /** Charges a prepared payment, once. Throws PaymentOutcomeUnknownError when the result is unclear. */
    charge(payment: PreparedPayment): Promise<PaymentReceipt>;
}

/**
 * Turns user input into a safe USD amount: a positive number, at most two
 * decimals, at most MAX_PAYMENT_USD. Throws BillingInputError otherwise.
 */
export function parseAmount(input: unknown): number {
    const n = typeof input === "string" ? Number(input.trim()) : input;

    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
        throw new BillingInputError("Enter an amount greater than zero.");
    }

    const cents = Math.round(n * 100);
    if (Math.abs(n * 100 - cents) > 1e-6) {
        throw new BillingInputError("Use at most two decimal places.");
    }

    if (cents > MAX_PAYMENT_USD * 100) {
        throw new BillingInputError(`The most you can pay at once from here is USD ${MAX_PAYMENT_USD}.`);
    }

    return cents / 100;
}

function methodLabel(m: { type: string; cardType: string; lastFour: string }): string {
    if (m.type === "paypal") return "PayPal";

    if (m.type === "google_pay") {
        return m.lastFour ? `Google Pay \u2022\u2022${m.lastFour}` : "Google Pay";
    }

    const brand = m.cardType || "Card";
    return m.lastFour ? `${brand} \u2022\u2022${m.lastFour}` : brand;
}

// ---------------------------------------------------------------------------
// Linode
// ---------------------------------------------------------------------------

class LinodeBilling implements ProviderBilling {
    kind = "linode";
    private client: LinodeClient;

    constructor(token: string) {
        this.client = new LinodeClient(token);
    }

    async summary(): Promise<BillingSummary> {
        const a = await this.client.getAccount();

        return {
            currency: "USD",
            balance: a.balance,
            amountDue: Math.max(a.balance, 0),
            credit: Math.max(-a.balance, 0),
            uninvoiced: a.balanceUninvoiced,
        };
    }

    invoices(): Promise<BillingInvoice[]> {
        return this.client.listInvoices();
    }

    async methods(): Promise<BillingMethod[]> {
        const rows = await this.client.listPaymentMethods();

        return rows.map((m) => {
            const isCard = m.type === "credit_card";

            return {
                id: m.id,
                type: m.type,
                isDefault: m.isDefault,
                label: methodLabel(m),
                needsCvv: isCard,
                payable: !isCard || ALLOW_CARD_PAYMENTS,
            };
        });
    }

    async prepare(amount: unknown, methodId: unknown, cvv?: unknown): Promise<PreparedPayment> {
        const clean = parseAmount(amount);
        const id = Number(methodId);

        if (!Number.isInteger(id) || id <= 0) {
            throw new BillingInputError("Choose a payment method.");
        }

        // Only ever charge a method that is really on this account.
        const method = (await this.methods()).find((m) => m.id === id);
        if (!method) {
            throw new BillingInputError("That payment method isn't on this Linode account.");
        }

        if (!method.payable) {
            throw new BillingInputError(
                "Card payments aren't enabled here. Pay by card on Linode's billing page, or use Google Pay or PayPal.",
            );
        }

        let code: string | undefined;
        if (method.needsCvv) {
            code = String(cvv ?? "").trim();
            if (!/^\d{3,4}$/.test(code)) {
                throw new BillingInputError("Enter the card's 3 or 4 digit security code (CVV).");
            }
        }

        return { amount: clean, methodId: id, methodLabel: method.label, cvv: code };
    }

    async charge(payment: PreparedPayment): Promise<PaymentReceipt> {
        try {
            const result = await this.client.makePayment(payment.amount, payment.methodId, payment.cvv);
            return { id: result.id, date: result.date, amount: result.usd, currency: "USD" };
        } catch (error) {
            // No response, or a server error: the charge may have happened.
            if (error instanceof LinodeError && (error.status === 0 || error.status >= 500)) {
                throw new PaymentOutcomeUnknownError();
            }
            throw error;
        }
    }
}

// ---------------------------------------------------------------------------

/**
 * The billing capability for a provider kind, or null when the deployer can't
 * talk to that provider's billing (use billingConsoleUrl() for those).
 * `secret` is the decrypted token from providerSecret(row).
 */
export function billingFor(kind: string, secret: string): ProviderBilling | null {
    switch (kind) {
        case "linode":
            return new LinodeBilling(secret);
        default:
            return null;
    }
}