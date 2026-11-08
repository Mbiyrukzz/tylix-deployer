
import type { Schema } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.raw("ALTER TABLE deployments ADD COLUMN cancel_requested INT NOT NULL DEFAULT 0");
    await schema.raw("ALTER TABLE deployments ADD COLUMN runner VARCHAR(64) NULL");
    await schema.raw("ALTER TABLE deployments ADD COLUMN queued_at VARCHAR(40) NULL");
    await schema.raw("ALTER TABLE deployments ADD COLUMN heartbeat_at VARCHAR(40) NULL");
};

export const down = async (schema: Schema) => {
    await schema.raw("ALTER TABLE deployments DROP COLUMN heartbeat_at");
    await schema.raw("ALTER TABLE deployments DROP COLUMN queued_at");
    await schema.raw("ALTER TABLE deployments DROP COLUMN runner");
    await schema.raw("ALTER TABLE deployments DROP COLUMN cancel_requested");
};
