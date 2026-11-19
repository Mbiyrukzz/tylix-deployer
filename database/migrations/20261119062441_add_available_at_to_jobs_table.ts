import type { Schema, AlterTableBuilder } from '@tylix/shared'

// When a queued job may run next: dispatch(..., { delay }) and retry backoff.
export const up = async (schema: Schema) => {
  await schema.alterTable('jobs', (table: AlterTableBuilder) => {
    table.datetime('available_at')
  })
}

export const down = async (schema: Schema) => {
  await schema.alterTable('jobs', (table: AlterTableBuilder) => {
    table.dropColumn('available_at')
  })
}
