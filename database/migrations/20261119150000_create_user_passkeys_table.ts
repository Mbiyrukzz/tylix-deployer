import type { Schema, CreateTableBuilder } from "@tylix/shared";

// Passkeys (WebAuthn credentials), Settings -> Two-factor. A user may have
// several (a phone, a laptop, a security key). Only the public key is kept:
// the private key never leaves the person's device or password manager.
export const up = async (schema: Schema) => {
    await schema.createTable("user_passkeys", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id").index();
        // base64url credential id from the authenticator (up to 1023 bytes by
        // spec; real ones are 16-64), looked up on every passkey sign-in.
        table.string("credential_id", 512).unique();
        // The same random value for all of a user's passkeys (WebAuthn user.id).
        table.string("user_handle", 64);
        // SubjectPublicKeyInfo (DER), base64.
        table.text("public_key");
        // COSE algorithm: -7 ES256, -257 RS256, -8 EdDSA.
        table.integer("algorithm");
        table.bigInteger("sign_count").default(0);
        table.string("name", 100);
        table.string("transports", 200).default("[]");
        table.string("aaguid", 36);
        // Synced passkeys (iCloud Keychain, Google Password Manager, 1Password)
        // are backed up; security keys are not.
        table.boolean("backed_up").default(false);
        table.string("last_used_at").nullable();
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("user_passkeys");
};
