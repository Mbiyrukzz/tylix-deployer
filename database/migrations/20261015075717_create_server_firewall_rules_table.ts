import type { Schema, CreateTableBuilder } from "@tylix/shared";

export const up = async (schema: Schema) => {
    await schema.createTable("server_firewall_rules", (table: CreateTableBuilder) => {
        table.increments("id");
        table.integer("user_id");
        table.integer("server_id");
        table.string("name");
        table.string("type");      // allow | deny
        table.string("source");    // "any", an IP, or a CIDR
        table.string("protocol");  // tcp | udp
        table.string("port");      // "443" or a range like "6000:6010"
        table.string("status");    // pending | ready | failed
        table.text("error");
        table.timestamps();
    });
};

export const down = async (schema: Schema) => {
    await schema.dropTable("server_firewall_rules");
};