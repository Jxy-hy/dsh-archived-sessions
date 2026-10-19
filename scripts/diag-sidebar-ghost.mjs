/**
 * Determine whether a deleted session survives in the CORE session list.
 *
 * The plugin's own /list is one source; the sidebar renders from the core
 * `session.list` RPC. If a delete removes the log and the projection cache but
 * the core still returns the row, the session "comes back" in the sidebar while
 * disappearing from the archived list — the reported symptom.
 *
 * Run: node scripts/diag-sidebar-ghost.mjs
 */

import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.DSH_PROBE_PORT ?? '1694'
const BASE = `http://127.0.0.1:${PORT}`
const HOME = process.env.DSH_HOME ?? 'C:\\Users\\jing\\.dsh'
const SEG = '--D-Program~0020Files~0020~0028x86~0029-deepseek-harness--'
const ID = `session-ghost-${Date.now().toString(16)}`
const LOG_DIR = join(HOME, 'sessions', SEG, ID)
const CACHE = join(HOME, 'storages', 'session_projcache', 'sessions', `${ID}.json`)

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function get(path) {
  const res = await fetch(BASE + path)
  return { status: res.status, body: await res.json() }
}

function seed() {
  mkdirSync(LOG_DIR, { recursive: true })
  const header = {
    type: 'session', version: 4, id: ID, createdAt: Date.now(),
    cwd: 'D:\\Program Files (x86)\\deepseek-harness', isSeeded: false,
    delegationDepth: 0, agentPreset: 'standard',
  }
  writeFileSync(join(LOG_DIR, 'session.v4.jsonl'), JSON.stringify(header) + '\n')
  mkdirSync(join(HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(CACHE, JSON.stringify({
    version: 1,
    record: {
      identity: { formatVersion: 4, createdAt: header.createdAt, cwd: header.cwd, isSeeded: false },
      rows: { sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt: Date.now() } } },
    },
  }))
}

/** Every place this id could still be listed. */
function diskState() {
  const logDirs = readdirSync(join(HOME, 'sessions'), { recursive: true })
    .filter(p => typeof p === 'string' && p.split(/[\\/]/).includes(ID))
  const cacheRows = readdirSync(join(HOME, 'storages', 'session_projcache', 'sessions'))
    .filter(f => f.startsWith(ID))
  return { logDirs: logDirs.length, cacheRows: cacheRows.length }
}

async function main() {
  console.log(`port: ${PORT}`)
  console.log(`synthetic session: ${ID}\n`)
  seed()

  const before = diskState()
  console.log('after seeding      :', JSON.stringify(before))

  const del = await post('/__dsh-archived-sessions/delete', { sessionId: ID })
  console.log('delete response    :', JSON.stringify(del.body))

  const after = diskState()
  console.log('after delete (disk):', JSON.stringify(after))

  // The plugin's own view
  const pluginList = await get('/__dsh-archived-sessions/list')
  const inPlugin = (pluginList.body.rows ?? []).some(r => r.id === ID)
  console.log('in plugin /list    :', inPlugin)

  console.log('\n=== CONCLUSION ===')
  if (after.logDirs === 0 && after.cacheRows === 0) {
    console.log('disk is clean: log dir and projection-cache row are both gone.')
    console.log('If the sidebar still shows it, the row lives in the HOST session index')
    console.log('(sessionQuery / persistence list) or in the browser client cache, not on disk')
    console.log('under sessions/ or session_projcache/.')
  } else {
    console.log('BUG: something survived on disk:', JSON.stringify(after))
  }

  // cleanup
  rmSync(LOG_DIR, { recursive: true, force: true })
  rmSync(CACHE, { force: true })
  console.log('\n(cleaned up synthetic session)')
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
