/**
 * Feature: Server (hand-written validator)
 *
 * Keeps the validate${Model} naming convention from feature.json
 * (validateServer) but is written by hand, because a server record ends up
 * in ssh command lines later and needs stricter checks than "is a string":
 *
 *   - host must be a plain hostname / IPv4 / IPv6 and can never start with "-"
 *     (blocks option injection like "-oProxyCommand=...")
 *   - ssh_user must be a normal unix username
 *   - ssh_key must look like a private key and must NOT be passphrase-protected
 *     (the deployer connects non-interactively)
 */

const HOSTNAME =
    /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/;
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const MAX_KEY_BYTES = 16 * 1024;

export interface NormalizedServer {
    name: string;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
}

/**
 * Trims and normalizes raw request data. validateServer() runs on this
 * output, and the controller stores this output, so both always agree.
 */
export function normalizeServer(data: Record<string, unknown>): NormalizedServer {
    const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    const key =
        typeof data.ssh_key === "string" ? data.ssh_key.replace(/\r\n/g, "\n").trim() : "";

    const rawPort = data.port;
    const port =
        rawPort === undefined || rawPort === null || rawPort === "" ? 22 : Number(rawPort);

    return {
        name: str(data.name),
        host: str(data.host).toLowerCase(),
        port,
        ssh_user: str(data.ssh_user),
        // OpenSSH refuses keys without a trailing newline.
        ssh_key: key ? key + "\n" : "",
    };
}

function isPassphraseProtected(key: string): boolean {
    // Old PEM formats: "Proc-Type: 4,ENCRYPTED" or "BEGIN ENCRYPTED PRIVATE KEY"
    if (/Proc-Type:.*ENCRYPTED|BEGIN ENCRYPTED PRIVATE KEY/.test(key)) return true;

    // New OpenSSH format: the cipher name is stored inside the key body.
    if (key.includes("BEGIN OPENSSH PRIVATE KEY")) {
        const body = key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
        const buf = Buffer.from(body, "base64");
        const magic = "openssh-key-v1\0";

        if (
            buf.length > magic.length + 4 &&
            buf.subarray(0, magic.length).toString("latin1") === magic
        ) {
            const length = buf.readUInt32BE(magic.length);
            const start = magic.length + 4;
            const cipher = buf.subarray(start, start + length).toString("latin1");
            return cipher !== "none";
        }
    }

    return false;
}

export function validateServer(
    data: Record<string, unknown>,
    options: { isUpdate?: boolean } = {},
) {
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        if (!errors[field]) errors[field] = [];
        errors[field].push(message);
    };

    const input = normalizeServer(data ?? {});

    if (!input.name) {
        fail("name", "Name is required.");
    } else if (input.name.length > 100) {
        fail("name", "Name must be 100 characters or fewer.");
    }

    if (!input.host) {
        fail("host", "Host is required.");
    } else if (!HOSTNAME.test(input.host) && !IPV6.test(input.host)) {
        fail("host", "Enter a valid hostname or IP address.");
    }

    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
        fail("port", "Port must be a whole number between 1 and 65535.");
    }

    if (!input.ssh_user) {
        fail("ssh_user", "SSH user is required.");
    } else if (!SSH_USER.test(input.ssh_user)) {
        fail("ssh_user", "SSH user must be a valid unix username.");
    }

    const keyProvided = input.ssh_key !== "";
    if (!keyProvided) {
        // On update the key is optional: omitting it keeps the stored one.
        if (!options.isUpdate) fail("ssh_key", "SSH private key is required.");
    } else if (Buffer.byteLength(input.ssh_key) > MAX_KEY_BYTES) {
        fail("ssh_key", "That key is too large to be a private key.");
    } else if (
        !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(input.ssh_key) ||
        !/-----END [A-Z ]*PRIVATE KEY-----/.test(input.ssh_key)
    ) {
        fail("ssh_key", "Paste the full private key, including the BEGIN and END lines.");
    } else if (isPassphraseProtected(input.ssh_key)) {
        fail(
            "ssh_key",
            "Passphrase-protected keys aren't supported. Generate a dedicated key without a passphrase.",
        );
    }

    return { valid: Object.keys(errors).length === 0, errors };
}