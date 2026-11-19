/**
 * Passkeys (WebAuthn Level 2) without dependencies: the server side of
 * navigator.credentials.create() / .get().
 *
 *   registration   options -> browser creates a key pair -> verifyRegistration
 *                  checks the client data and authenticator data and keeps
 *                  the public key (attestation "none": we don't ask which
 *                  make of authenticator it is).
 *   sign-in        options -> browser signs the challenge -> verifyAssertion
 *                  checks the signature against the stored public key.
 *
 * Every passkey must verify the user (fingerprint, face, PIN), so a passkey
 * sign-in is two factors on its own and skips the authenticator / SMS code.
 *
 * The relying party is the app's own origin: PASSKEY_ORIGIN, else APP_URL,
 * else the request's host. Passkeys only work on that exact origin
 * (localhost is allowed over plain http; everything else needs https).
 */

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";
import type { TylixRequest } from "@tylix/core";

export const ES256 = -7;
export const RS256 = -257;
export const EDDSA = -8;
export const SUPPORTED_ALGORITHMS = [ES256, EDDSA, RS256];

const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified
const FLAG_BE = 0x08; // backup eligible
const FLAG_BS = 0x10; // backed up
const FLAG_AT = 0x40; // attested credential data included

export class PasskeyError extends Error {}

// ---------------------------------------------------------------- encoding

export function b64url(bytes: Buffer | Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function fromB64url(value: unknown, what: string): Buffer {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(value) || value.length === 0) {
        throw new PasskeyError(`The browser sent an unreadable ${what}.`);
    }
    return Buffer.from(value, "base64url");
}

export function newChallenge(): string {
    return b64url(randomBytes(32));
}

export function newUserHandle(): string {
    return b64url(randomBytes(32));
}

// ---------------------------------------------------------------- CBOR (the subset WebAuthn uses)

type Cbor = number | bigint | string | boolean | null | undefined | Buffer | Cbor[] | Map<Cbor, Cbor>;

function decodeCbor(buf: Buffer, start = 0): { value: Cbor; end: number } {
    let at = start;
    const need = (n: number) => {
        if (at + n > buf.length) throw new PasskeyError("The authenticator sent truncated data.");
    };
    const readLength = (info: number): number => {
        if (info < 24) return info;
        if (info === 24) {
            need(1);
            return buf[at++];
        }
        if (info === 25) {
            need(2);
            const v = buf.readUInt16BE(at);
            at += 2;
            return v;
        }
        if (info === 26) {
            need(4);
            const v = buf.readUInt32BE(at);
            at += 4;
            return v;
        }
        if (info === 27) {
            need(8);
            const v = buf.readBigUInt64BE(at);
            at += 8;
            if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PasskeyError("The authenticator sent a number that is too large.");
            return Number(v);
        }
        throw new PasskeyError("The authenticator sent data this server can't read.");
    };

    const item = (depth: number): Cbor => {
        if (depth > 16) throw new PasskeyError("The authenticator sent data nested too deeply.");
        need(1);
        const head = buf[at++];
        const major = head >> 5;
        const info = head & 0x1f;
        switch (major) {
            case 0:
                return readLength(info);
            case 1:
                return -1 - readLength(info);
            case 2: {
                const n = readLength(info);
                need(n);
                const out = buf.subarray(at, at + n);
                at += n;
                return Buffer.from(out);
            }
            case 3: {
                const n = readLength(info);
                need(n);
                const out = buf.toString("utf8", at, at + n);
                at += n;
                return out;
            }
            case 4: {
                const n = readLength(info);
                const list: Cbor[] = [];
                for (let i = 0; i < n; i++) list.push(item(depth + 1));
                return list;
            }
            case 5: {
                const n = readLength(info);
                const map = new Map<Cbor, Cbor>();
                for (let i = 0; i < n; i++) {
                    const key = item(depth + 1);
                    map.set(key, item(depth + 1));
                }
                return map;
            }
            case 7:
                if (info === 20) return false;
                if (info === 21) return true;
                if (info === 22) return null;
                if (info === 23) return undefined;
                throw new PasskeyError("The authenticator sent data this server can't read.");
            default:
                throw new PasskeyError("The authenticator sent data this server can't read.");
        }
    };

    const value = item(0);
    return { value, end: at };
}

// ---------------------------------------------------------------- COSE public keys

function coseToKey(cose: Cbor): { key: KeyObject; algorithm: number } {
    if (!(cose instanceof Map)) throw new PasskeyError("The authenticator sent a public key this server can't read.");
    const kty = cose.get(1);
    const alg = cose.get(3);
    const bytes = (label: number): string => {
        const v = cose.get(label);
        if (!Buffer.isBuffer(v)) throw new PasskeyError("The authenticator sent an incomplete public key.");
        return b64url(v);
    };

    let jwk: JsonWebKey;
    if (kty === 2 && alg === ES256 && cose.get(-1) === 1) {
        jwk = { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) };
    } else if (kty === 1 && alg === EDDSA && cose.get(-1) === 6) {
        jwk = { kty: "OKP", crv: "Ed25519", x: bytes(-2) };
    } else if (kty === 3 && alg === RS256) {
        jwk = { kty: "RSA", n: bytes(-1), e: bytes(-2) };
    } else {
        throw new PasskeyError("That passkey uses a signing algorithm this app doesn't support.");
    }

    try {
        return { key: createPublicKey({ key: jwk, format: "jwk" }), algorithm: alg as number };
    } catch {
        throw new PasskeyError("The authenticator sent an invalid public key.");
    }
}

// ---------------------------------------------------------------- authenticator data

interface AuthData {
    rpIdHash: Buffer;
    flags: number;
    signCount: number;
    aaguid?: string;
    credentialId?: Buffer;
    publicKey?: Cbor;
}

function parseAuthData(data: Buffer): AuthData {
    if (data.length < 37) throw new PasskeyError("The authenticator sent truncated data.");
    const out: AuthData = {
        rpIdHash: data.subarray(0, 32),
        flags: data[32],
        signCount: data.readUInt32BE(33),
    };
    if (out.flags & FLAG_AT) {
        if (data.length < 55) throw new PasskeyError("The authenticator sent truncated data.");
        const hex = data.subarray(37, 53).toString("hex");
        out.aaguid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        const idLength = data.readUInt16BE(53);
        if (data.length < 55 + idLength) throw new PasskeyError("The authenticator sent truncated data.");
        out.credentialId = Buffer.from(data.subarray(55, 55 + idLength));
        out.publicKey = decodeCbor(data, 55 + idLength).value;
    }
    return out;
}

// ---------------------------------------------------------------- relying party

export interface RelyingParty {
    id: string;
    name: string;
    origin: string;
}

export function relyingParty(req: TylixRequest): RelyingParty {
    const configured = process.env.PASSKEY_ORIGIN || process.env.APP_URL || "";
    let origin = "";
    try {
        origin = configured ? new URL(configured).origin : "";
    } catch {
        origin = "";
    }
    if (!origin) {
        const headers = req.headers as Record<string, string | string[] | undefined>;
        const host = String(headers["x-forwarded-host"] ?? headers.host ?? "localhost:3000").split(",")[0].trim();
        const proto = String(headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || (host.startsWith("localhost") ? "http" : "https");
        origin = `${proto}://${host}`;
    }
    return { id: new URL(origin).hostname, name: "Tylix Flux", origin };
}

function checkClientData(raw: Buffer, type: string, challenge: string, rp: RelyingParty) {
    let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
    try {
        data = JSON.parse(raw.toString("utf8"));
    } catch {
        throw new PasskeyError("The browser sent unreadable client data.");
    }
    if (data.type !== type) throw new PasskeyError("The browser answered a different kind of request.");
    if (typeof data.challenge !== "string" || data.challenge.replace(/=+$/, "") !== challenge) {
        throw new PasskeyError("This passkey request has expired. Try again.");
    }
    if (data.origin !== rp.origin) {
        throw new PasskeyError(`Passkeys work on ${rp.origin} only. Open the app there and try again.`);
    }
    if (data.crossOrigin === true) throw new PasskeyError("Passkeys can't be used from an embedded page.");
}

function checkFlags(auth: AuthData, rp: RelyingParty) {
    const expected = createHash("sha256").update(rp.id).digest();
    if (!auth.rpIdHash.equals(expected)) throw new PasskeyError(`That passkey belongs to another site, not ${rp.id}.`);
    if (!(auth.flags & FLAG_UP)) throw new PasskeyError("The passkey didn't confirm you were there. Try again.");
    if (!(auth.flags & FLAG_UV)) {
        throw new PasskeyError("The passkey didn't verify you (fingerprint, face or PIN). Use one that can.");
    }
}

// ---------------------------------------------------------------- registration

export interface RegistrationInput {
    rawId?: unknown;
    id?: unknown;
    type?: unknown;
    response?: { clientDataJSON?: unknown; attestationObject?: unknown; transports?: unknown };
}

export interface VerifiedRegistration {
    credentialId: string;
    publicKey: string;
    algorithm: number;
    signCount: number;
    aaguid: string;
    backedUp: boolean;
    transports: string[];
}

const TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card", "cable"]);

export function verifyRegistration(input: RegistrationInput, challenge: string, rp: RelyingParty): VerifiedRegistration {
    if (!input || input.type !== "public-key" || !input.response) throw new PasskeyError("The browser didn't send a passkey.");

    const clientData = fromB64url(input.response.clientDataJSON, "client data");
    checkClientData(clientData, "webauthn.create", challenge, rp);

    const attestation = decodeCbor(fromB64url(input.response.attestationObject, "attestation")).value;
    if (!(attestation instanceof Map)) throw new PasskeyError("The authenticator sent an unreadable attestation.");
    const authBytes = attestation.get("authData");
    if (!Buffer.isBuffer(authBytes)) throw new PasskeyError("The authenticator sent an unreadable attestation.");

    const auth = parseAuthData(authBytes);
    checkFlags(auth, rp);
    if (!auth.credentialId || auth.publicKey === undefined) throw new PasskeyError("The authenticator didn't include a new key.");

    const rawId = fromB64url(input.rawId ?? input.id, "credential id");
    if (!rawId.equals(auth.credentialId)) throw new PasskeyError("The passkey's id doesn't match its data.");
    if (rawId.length > 380) throw new PasskeyError("That passkey's id is too long to store.");

    const { key, algorithm } = coseToKey(auth.publicKey);
    const transports = Array.isArray(input.response.transports)
        ? input.response.transports.filter((t): t is string => typeof t === "string" && TRANSPORTS.has(t)).slice(0, 8)
        : [];

    return {
        credentialId: b64url(rawId),
        publicKey: key.export({ type: "spki", format: "der" }).toString("base64"),
        algorithm,
        signCount: auth.signCount,
        aaguid: auth.aaguid ?? "00000000-0000-0000-0000-000000000000",
        // Synced (backed up), or at least able to sync.
        backedUp: Boolean(auth.flags & (FLAG_BS | FLAG_BE)),
        transports,
    };
}

// ---------------------------------------------------------------- sign-in

export interface AssertionInput {
    rawId?: unknown;
    id?: unknown;
    type?: unknown;
    response?: { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown; userHandle?: unknown };
}

export function credentialIdOf(input: AssertionInput): string {
    return b64url(fromB64url(input?.rawId ?? input?.id, "credential id"));
}

export interface StoredPasskey {
    public_key: string;
    algorithm: number;
    sign_count: number;
    user_handle: string;
}

/** Checks a sign-in and returns the authenticator's new signature counter and backup state. */
export function verifyAssertion(
    input: AssertionInput,
    stored: StoredPasskey,
    challenge: string,
    rp: RelyingParty,
): { signCount: number; backedUp: boolean } {
    if (!input || input.type !== "public-key" || !input.response) throw new PasskeyError("The browser didn't send a passkey.");

    const clientData = fromB64url(input.response.clientDataJSON, "client data");
    checkClientData(clientData, "webauthn.get", challenge, rp);

    const authBytes = fromB64url(input.response.authenticatorData, "authenticator data");
    const auth = parseAuthData(authBytes);
    checkFlags(auth, rp);

    // Discoverable passkeys say whose they are; it must be this account.
    const handle = input.response.userHandle;
    if (typeof handle === "string" && handle !== "" && b64url(fromB64url(handle, "user handle")) !== stored.user_handle) {
        throw new PasskeyError("That passkey doesn't belong to this account.");
    }

    const signature = fromB64url(input.response.signature, "signature");
    const signed = Buffer.concat([authBytes, createHash("sha256").update(clientData).digest()]);
    const key = createPublicKey({ key: Buffer.from(stored.public_key, "base64"), format: "der", type: "spki" });

    let ok = false;
    try {
        if (Number(stored.algorithm) === EDDSA) ok = verifySignature(null, signed, key, signature);
        else if (Number(stored.algorithm) === ES256) ok = verifySignature("sha256", signed, { key, dsaEncoding: "der" }, signature);
        else if (Number(stored.algorithm) === RS256) ok = verifySignature("sha256", signed, key, signature);
    } catch {
        ok = false;
    }
    if (!ok) throw new PasskeyError("That passkey's signature didn't check out.");

    // A counter that goes backwards means the key may have been copied.
    // Synced passkeys always report 0, which is fine.
    const before = Number(stored.sign_count) || 0;
    if ((auth.signCount !== 0 || before !== 0) && auth.signCount <= before) {
        throw new PasskeyError("That passkey looks like a copy of another one, so it was refused. Remove it and add it again.");
    }

    return { signCount: auth.signCount, backedUp: Boolean(auth.flags & FLAG_BS) };
}
