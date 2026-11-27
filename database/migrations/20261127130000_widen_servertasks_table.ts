import type { Schema, AlterTableBuilder } from "@tylix/shared";

// Package installs stopped silently when a step failed: the failure message
// (step label plus the end of apt's output) was longer than the 255-character
// error column, MySQL refused the update, and the task stayed "running".
// The error and the package list become TEXT, and each task keeps the output
// of its steps (log) and where it is (step_no of step_total).
export const up = async (schema: Schema) => {
    await schema.alterTable("servertasks", (table: AlterTableBuilder) => {
        table.text("packages").change();
        table.text("error").change();
        table.longText("log");
        table.integer("step_no");
        table.integer("step_total");
    });
};

export const down = async (schema: Schema) => {
    await schema.alterTable("servertasks", (table: AlterTableBuilder) => {
        table.dropColumn("log");
        table.dropColumn("step_no");
        table.dropColumn("step_total");
        table.string("error").change();
        table.string("packages").change();
    });
};
