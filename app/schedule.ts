import type { Scheduler } from '@tylix/core'
import { Provision } from './models/Provision.js'

// Only lower this to test the sweep. A healthy provision can sit on one step for minutes.
const STALE_MS = Number(process.env.PROVISION_STALE_MINUTES ?? 15) * 60 * 1000

export async function schedule(scheduler: Scheduler) {
  // A provision the worker stopped handling (crash, restart) would stay "running"
  // forever. Mark it failed so Retry and Delete become available. Never auto-retry:
  // that could repeat a billable step without anyone watching.
  scheduler.every('1m', async () => {
    try {
      const rows = (await Provision.all()) as { id: number; status: string; updated_at: string }[]
      const now = Date.now()

      for (const row of rows) {
        if (row.status !== 'running' && row.status !== 'pending') continue
        if (now - new Date(row.updated_at).getTime() < STALE_MS) continue

        await Provision.update(row.id, {
          status: 'failed',
          error:
            row.status === 'pending'
              ? 'No worker picked this up. Is queue:work running? Press Retry.'
              : 'Stopped unexpectedly. Press Retry to resume, or delete it.',
        })
        console.log(`Provision sweep: marked #${row.id} failed (was ${row.status})`)
      }
    } catch (error) {
      console.error('Provision sweep failed:', error instanceof Error ? error.message : error)
    }
  })
}
