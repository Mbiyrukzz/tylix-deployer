import type { Schema } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.raw("ALTER TABLE deployments MODIFY log MEDIUMTEXT");
    await schema.raw("ALTER TABLE sites MODIFY deploy_log MEDIUMTEXT");
};

export const down = async (schema: Schema) => {
    await schema.raw("ALTER TABLE deployments MODIFY log TEXT");
    await schema.raw("ALTER TABLE sites MODIFY deploy_log TEXT");
};
