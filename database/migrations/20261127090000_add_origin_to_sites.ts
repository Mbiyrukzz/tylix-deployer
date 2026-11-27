import type { Schema, AlterTableBuilder } from "@tylix/shared";

// "" for sites Flux created, "import" for sites adopted from a server by the
// importer (ServerImport). Imported sites share their unix user with other
// sites, so deleting one must only remove that site's own files.
export const up = async (schema: Schema) => {
    await schema.alterTable("sites", (table: AlterTableBuilder) => {
        table.string("origin");
    });
};

export const down = async (schema: Schema) => {
    await schema.alterTable("sites", (table: AlterTableBuilder) => {
        table.dropColumn("origin");
    });
};
