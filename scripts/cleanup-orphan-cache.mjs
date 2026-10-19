/**
 * Remove projection-cache rows whose session log no longer exists.
 *
 * These orphans are what makes the sidebar list conversations that open empty:
 * the listing serves its projection column from these rows, so a row outlives
 * its log and the row is rendered with nothing behind it. They accumulate from
 * deletions that removed the log but not the row (the bug fixed in v0.1.3) and
 * from logs removed by hand.
 *
 * Safety: a row is deleted only when NO log artifact for that id exists
 * anywhere under the sessions root. Rows that still have a log are left alone,
 * and every removal is reported. Dry run by default.
 *
 * Run: node scripts/cleanup-orphan-cache.mjs [--apply]
 */

import { readdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const APPLY = process.argv.includes('--apply')
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const CACHE_DIR = join(HOME, 'storages', 'session_projcache', 'sessions')
const SESSIONS_ROOT = join(HOME, 'sessions')

console.log(`DSH_HOME : ${HOME}`)
console.log(`mode     : ${APPLY ? 'APPLY' : 'DRY RUN'}\n`)

// Every session id that still has any log artifact.
const entries = readdirSync(SESSIONS_ROOT, { recursive: true })
const withLog = new Set()
for (const entry of entries) {
  if (typeof entry !== 'string') continue
  for (const segment of entry.split(/[\\/]/)) {
    if (/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(segment)) {
      withLog.add(segment)
    }
  }
}

const rows = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))
const orphans = []
const kept = []
for (const file of rows) {
  const id = file.replace(/\.json$/, '')
  // Bare-uuid rows are a legacy layout whose owner cannot be matched to a log
  // by name; leave them for a dedicated migration rather than guess.
  if (!id.startsWith('session-')) { kept.push([id, 'legacy bare-uuid row']); continue }
  if (withLog.has(id)) { kept.push([id, 'has a log']); continue }
  const path = join(CACHE_DIR, file)
  orphans.push({ id, path, bytes: statSync(path).size })
}

console.log(`cache rows : ${rows.length}`)
console.log(`with log   : ${withLog.size}`)
console.log(`\n=== ORPHANS (row with no log): ${orphans.length} ===`)
for (const o of orphans) console.log(`  ${o.id}  ${o.bytes} B`)
console.log(`\nkept: ${kept.length} (has log, or legacy layout)`)

if (!APPLY) {
  console.log(`\nDry run: ${orphans.length} rows would be removed. Re-run with --apply.`)
  process.exit(0)
}

let removed = 0
for (const o of orphans) {
  try {
    rmSync(o.path, { force: true })
    if (!existsSync(o.path)) removed++
  } catch (error) {
    console.log(`  WARN ${o.id}: ${String(error).slice(0, 60)}`)
  }
}
console.log(`\n${removed}/${orphans.length} orphan rows removed.`)
