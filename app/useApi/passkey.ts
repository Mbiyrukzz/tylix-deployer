/**
 * Browser side of passkeys (WebAuthn) for Settings -> Two-factor and the
 * login page. The server sends options with base64url strings; WebAuthn
 * wants ArrayBuffers, and the answer goes back as base64url again.
 *
 * Every helper here is concatenated into the page bundle, so top-level names
 * carry a passkey prefix.
 */

interface PasskeyResult {
    ok: boolean;
    credential?: Record<string, unknown>;
    /** "cancelled" when the person closed the prompt or it timed out. */
    error?: string;
    cancelled?: boolean;
}

function passkeyToBuffer(value: string): ArrayBuffer {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function passkeyToBase64url(buffer: ArrayBuffer | null): string {
    if (!buffer) return "";
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function passkeyFailure(err: unknown): PasskeyResult {
    const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
    if (name === "NotAllowedError" || name === "AbortError") {
        return { ok: false, cancelled: true, error: "The passkey prompt was closed or timed out." };
    }
    if (name === "InvalidStateError") {
        return { ok: false, error: "This device already has a passkey for your account." };
    }
    if (name === "SecurityError") {
        return { ok: false, error: "Passkeys need this app's real address over HTTPS (or localhost)." };
    }
    if (name === "NotSupportedError") {
        return { ok: false, error: "This browser or device can't create that kind of passkey." };
    }
    const message = err instanceof Error && err.message ? err.message : "The passkey didn't work. Try again.";
    return { ok: false, error: message };
}

export const passkey = {
    /** True when the browser can use passkeys at all. */
    supported(): boolean {
        return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
    },

    /** True when the device has a built-in authenticator (Touch ID, Windows Hello, Android). */
    async platformAvailable(): Promise<boolean> {
        try {
            return this.supported() && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
        } catch {
            return false;
        }
    },

    /** navigator.credentials.create() with options from POST /api/account/passkeys/options. */
    async create(options: any): Promise<PasskeyResult> {
        if (!this.supported()) return { ok: false, error: "This browser doesn't support passkeys." };
        try {
            const publicKey: PublicKeyCredentialCreationOptions = {
                ...options,
                challenge: passkeyToBuffer(String(options.challenge)),
                user: { ...options.user, id: passkeyToBuffer(String(options.user.id)) },
                excludeCredentials: (options.excludeCredentials || []).map((c: any) => ({ type: "public-key", id: passkeyToBuffer(String(c.id)) })),
            };
            const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
            if (!cred) return { ok: false, cancelled: true, error: "No passkey was created." };
            const response = cred.response as AuthenticatorAttestationResponse;
            const transports = typeof response.getTransports === "function" ? response.getTransports() : [];
            return {
                ok: true,
                credential: {
                    id: cred.id,
                    rawId: passkeyToBase64url(cred.rawId),
                    type: cred.type,
                    response: {
                        clientDataJSON: passkeyToBase64url(response.clientDataJSON),
                        attestationObject: passkeyToBase64url(response.attestationObject),
                        transports,
                    },
                },
            };
        } catch (err) {
            return passkeyFailure(err);
        }
    },

    /** navigator.credentials.get() with options from POST /api/auth/passkey/options. */
    async get(options: any): Promise<PasskeyResult> {
        if (!this.supported()) return { ok: false, error: "This browser doesn't support passkeys." };
        try {
            const publicKey: PublicKeyCredentialRequestOptions = {
                ...options,
                challenge: passkeyToBuffer(String(options.challenge)),
                allowCredentials: (options.allowCredentials || []).map((c: any) => ({ type: "public-key", id: passkeyToBuffer(String(c.id)) })),
            };
            const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
            if (!cred) return { ok: false, cancelled: true, error: "No passkey was chosen." };
            const response = cred.response as AuthenticatorAssertionResponse;
            return {
                ok: true,
                credential: {
                    id: cred.id,
                    rawId: passkeyToBase64url(cred.rawId),
                    type: cred.type,
                    response: {
                        clientDataJSON: passkeyToBase64url(response.clientDataJSON),
                        authenticatorData: passkeyToBase64url(response.authenticatorData),
                        signature: passkeyToBase64url(response.signature),
                        userHandle: passkeyToBase64url(response.userHandle),
                    },
                },
            };
        } catch (err) {
            return passkeyFailure(err);
        }
    },

    /** A default name for a new passkey, from the device this browser runs on. */
    deviceName(): string {
        const ua = navigator.userAgent;
        let device = "This device";
        if (/iPhone/.test(ua)) device = "iPhone";
        else if (/iPad/.test(ua)) device = "iPad";
        else if (/Android/.test(ua)) device = "Android";
        else if (/Mac OS X/.test(ua)) device = "Mac";
        else if (/Windows/.test(ua)) device = "Windows";
        else if (/CrOS/.test(ua)) device = "Chromebook";
        else if (/Linux/.test(ua)) device = "Linux";
        let browser = "";
        if (/Edg\//.test(ua)) browser = "Edge";
        else if (/Firefox\//.test(ua)) browser = "Firefox";
        else if (/Chrome\//.test(ua)) browser = "Chrome";
        else if (/Safari\//.test(ua)) browser = "Safari";
        return browser ? device + " · " + browser : device;
    },
};
