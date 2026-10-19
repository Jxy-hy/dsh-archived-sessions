/**
 * Reproduce the reported delete bug against the LIVE harness, using a
 * throwaway session so no real conversation is touched.
 *
 * Creates a synthetic session log + projection cache entry under the real
 * DSH_HOME, archives it, then calls the plugin's /delete and reports exactly
 * what happened to: the log dir, the projection cache row, and the archive set.
 *
 * Run: node scripts/repro-delete-bug.mjs [--keep]
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.DSH_PROBE_PORT ?? '1694'
const BASE = `http://127.0.0.1:${PORT}`
const HOME = 'C:\\Users\\jing\\.dsh'
const SEG = '--D-Program~0020Files~0020~0028x86~0029-deepseek-harness--'
const ID = `session-repro-${Date.now().toString(16)}`
const LOG_DIR = join(HOME, 'sessions', SEG, ID)
const CACHE = join(HOME, 'storages', 'session_projcache', 'sessions', `${ID}.json`)
const KEEP = process.argv.includes('--keep')

async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

function seed() {
  mkdirSync(LOG_DIR, { recursive: true })
  // A minimal uncompressed log: the plugin reads it for attachment refs.
  const header = {
    type: 'session',
    version: 4,
    id: ID,
    createdAt: Date.now(),
    cwd: 'D:\\Program Files (x86)\\deepseek-harness',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  writeFileSync(join(LOG_DIR, 'session.v4.jsonl'), JSON.stringify(header) + '\n')
  // Projection cache row shaped like the real ones.
  mkdirSync(join(HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(CACHE, JSON.stringify({
    version: 1,
    record: {
      identity: { formatVersion: 4, createdAt: header.createdAt, cwd: header.cwd, isSeeded: false },
      rows: {
        sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt: Date.now() } },
      },
    },
  }))
}

function state(label) {
  const log = existsSync(LOG_DIR)
  const cache = existsSync(CACHE)
  console.log(`  ${label.padEnd(10)} logDir=${log ? 'PRESENT' : 'gone'}  cache=${cache ? 'PRESENT' : 'gone'}`)
  return { log, cache }
}

async function main() {
  console.log(`synthetic session: ${ID}`)
  seed()
  state('seeded')

  // The plugin only lists sessions it sees as archived. We cannot archive a
  // synthetic id through the core (it requires a known session), so ask the
  // delete route directly: it accepts any id and reports what it did.
  const before = await api('/__dsh-archived-sessions/list')
  console.log(`  archived rows before: ${before.body.rows?.length ?? 'n/a'}`)

  console.log('\n=== calling /delete on the synthetic id ===')
  const result = await api('/__dsh-archived-sessions/delete', { sessionId: ID })
  console.log('  status:', result.status)
  console.log('  body  :', JSON.stringify(result.body, null, 2))

  console.log('\n=== resulting state ===')
  const after = state('after')

  console.log('\n=== DIAGNOSIS ===')
  if (!after.log && !after.cache) {
    console.log('  log AND cache both removed -> delete works for this shape')
  } else {
    if (after.log) console.log('  BUG: log directory survived')
    if (after.cache) console.log('  BUG: projection cache row survived (this is what keeps the row listed)')
  }

  if (!KEEP) {
    rmSync(LOG_DIR, { recursive: true, force: true })
    rmSync(CACHE, { force: true })
    console.log('\n  (cleaned up the synthetic session)')
  } else {
    console.log('\n  (--keep: left the synthetic session in place for inspection)')
  }
}

main().catch((error) => {
  console.error('repro failed:', error)
  process.exitCode = 1
})
