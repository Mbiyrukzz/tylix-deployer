/**
 * Feature: Post (override)
 *
 * FeatureGenerator names this export validate${Model} by convention
 * (see feature.json's "validator" field / controller.tyx's import), so
 * this keeps that name — validatePost — even though it's hand-written
 * rather than produced by ValidatorGenerator.
 */

import { validate, required, isString } from "@tylix/shared";

const postSchema = {
    title: [required, isString],
    body: [required, isString],
};

export function validatePost(data: Record<string, unknown>) {
    return validate(data, postSchema);
}