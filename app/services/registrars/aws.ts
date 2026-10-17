/**
 * AWS Signature Version 4 with node:crypto only (no SDK), for Route 53 and
 * Route 53 Domains. Both live in us-east-1 whatever the account's region is.
 *
 * VERIFY BEFORE USE: the signer follows the SigV4 spec as I remember it. If AWS
 * answers SignatureDoesNotMatch with correct keys, the canonical request is wrong.
 */

import { createHash, createHmac } from "node:crypto";
import { http, RegistrarError, type Json } from "./http.js";
import { descendants, parseXml, textOf } from "./xml.js";

export interface AwsKeys {
    accessKeyId: string;
    secretAccessKey: string;
}

const REGION = "us-east-1";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s, "utf8").digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export async function awsRequest(opts: {
    keys: AwsKeys;
    service: string;
    host: string;
    method: string;
    /** Already URI-encoded. The paths used here only contain safe characters. */
    path: string;
    query?: Record<string, string>;
    body?: string;
    headers?: Record<string, string>;
}): Promise<{ status: number; data: Json; text: string }> {
    const body = opts.body ?? "";
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);

    const headers: Record<string, string> = { host: opts.host, "x-amz-date": amzDate };
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v.trim();

    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
    const signedHeaders = names.join(";");

    const query = Object.entries(opts.query ?? {})
        .map(([k, v]) => [enc(k), enc(v)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");

    const canonicalRequest = [opts.method, opts.path, query, canonicalHeaders, signedHeaders, sha256(body)].join("\n");
    const scope = `${day}/${REGION}/${opts.service}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

    const signingKey = hmac(hmac(hmac(hmac("AWS4" + opts.keys.secretAccessKey, day), REGION), opts.service), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${opts.keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    // fetch sets Host itself from the URL, which is the value we signed.
    const send = { ...headers, Authorization: authorization };
    delete (send as Record<string, string>).host;

    return http(`https://${opts.host}${opts.path}${query ? "?" + query : ""}`, {
        method: opts.method,
        headers: send,
        body: body || undefined,
    });
}

/** Turns an AWS error (JSON or XML body) into a RegistrarError the controller already knows how to map. */
export function awsError(status: number, data: Json, text: string): RegistrarError {
    let code = "";
    let message = "";

    if (data && (data.__type || data.message || data.Message)) {
        code = String(data.__type ?? "").split("#").pop() ?? "";
        message = String(data.message ?? data.Message ?? "");
    } else if (text.includes("<")) {
        const root = parseXml(text);
        code = textOf(descendants(root, "Code")[0]);
        message = textOf(descendants(root, "Message")[0]);
    }

    message ||= `AWS error (${status})`;

    const auth =
        /AccessDenied|UnrecognizedClient|InvalidClientTokenId|SignatureDoesNotMatch|InvalidSignature|ExpiredToken|MissingAuthentication|IncompleteSignature|AuthFailure|UnauthorizedOperation/i.test(
            code,
        );
    const throttled = /Throttl|RequestLimit|TooManyRequests/i.test(code);
    const missing = /NoSuch/i.test(code);

    return new RegistrarError(message, auth ? 403 : throttled ? 429 : missing ? 404 : status, code);
}