/**
 * One-shot cleanup: remove the sessions that are genuinely blank (never
 * prompted) from a previous verification, keeping every session that holds
 * content and the session this process is running in.
 *
 * Safety model — a session is deleted only when ALL of these hold:
 *   1. its projection cache says `blank: true`;
 *   2. its cache carries `lastPromptAt: null` (never prompted);
 *   3. its id is not DSH_SESSION_ID (never delete the running conversation);
 *   4. its id is not in the caller-supplied keep list.
 * Anything that fails a check is reported and left untouched.
 *
 * Run: node scripts/cleanup-blank-sessions.mjs [--apply]
 */

import { readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const APPLY = process.argv.includes('--apply')
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const CACHE_DIR = join(HOME, 'storages', 'session_projcache', 'sessions')
const SESSIONS_ROOT = join(HOME, 'sessions')

/** The 10 ids established as blank by the survey (blank:true, lastPromptAt:null). */
const CANDIDATES = [
  '4037e12b', '4824f244', '611afab4', '7a587faa', '7a9e9dc4',
  'ba10716a', 'c3ef6208', 'e7bb41dc', 'edb08fb8', 'f9739c93',
]

const currentSession = process.env.DSH_SESSION_ID ?? ''
/** Sessions with real content that must survive even if a check misfires. */
const KEEP = new Set([
  currentSession,
  'session-2b7a8086-a449-413a-b025-be65193cdbf4', // dsh-market install
  'session-190a3090-68b1-4274-9bfd-770ef0f87743', // multimodal config
  'session-48559cd8-a70a-4b53-b48e-fe6941711df7', // has content
  'session-324eef04-a384-4bc6-addb-b52e244e63ff', // this conversation
])

console.log(`DSH_HOME      : ${HOME}`)
console.log(`DSH_SESSION_ID: ${currentSession}`)
console.log(`mode          : ${APPLY ? 'APPLY (deletes)' : 'DRY RUN (no changes)'}\n`)

const cacheFiles = readdirSync(CACHE_DIR).filter(f => f.startsWith('session-') && f.endsWith('.json'))
const allEntries = readdirSync(SESSIONS_ROOT, { recursive: true })

const planned = [], skipped = []

for (const short of CANDIDATES) {
  const cacheName = cacheFiles.find(f => f.startsWith(`session-${short}`))
  if (cacheName === undefined) { skipped.push([short, 'no cache entry']); continue }
  const fullId = cacheName.replace(/\.json$/, '')

  let blankVal
  try {
    const o = JSON.parse(readFileSync(join(CACHE_DIR, cacheName), 'utf8'))
    blankVal = o?.record?.rows?.sessionListMetadata?.val
  } catch (error) { skipped.push([short, `unreadable cache (${String(error).slice(0, 40)})`]); continue }

  const isBlank = blankVal?.blank === true
  const neverPrompted = blankVal?.lastPromptAt === null
  if (blankVal === undefined) { skipped.push([short, 'cache has no sessionListMetadata']); continue }
  if (!isBlank) { skipped.push([short, 'cache says blank:false — has content']); continue }
  if (!neverPrompted) { skipped.push([short, 'cache records a lastPromptAt']); continue }
  if (KEEP.has(fullId) || fullId.includes(currentSession.replace(/^session-/, ''))) {
    skipped.push([short, 'protected (running session or keep list)']); continue
  }

  // Every directory under the sessions root whose name is exactly this id.
  const dirs = allEntries
    .filter(p => typeof p === 'string' && p.split(/[\\/]/).includes(fullId))
    .map(p => {
      const parts = p.split(/[\\/]/)
      return join(SESSIONS_ROOT, parts.slice(0, parts.indexOf(fullId) + 1).join('\\'))
    })
  const uniqueDirs = [...new Set(dirs)].filter(d => existsSync(d) && statSync(d).isDirectory())
  let bytes = 0
  for (const d of uniqueDirs) {
    for (const f of readdirSync(d)) {
      try { bytes += statSync(join(d, f)).size } catch { /* raced away */ }
    }
  }
  planned.push({ short, fullId, cachePath: join(CACHE_DIR, cacheName), dirs: uniqueDirs, bytes })
}

console.log('=== PLANNED DELETIONS ===')
for (const p of planned) {
  console.log(`  ${p.short}  ${p.dirs.length} log dir(s), ${p.bytes} B  ${p.dirs.map(d => d.split('\\').slice(-2)[0]).join(',') || '(no log dir)'}`)
}
console.log('\n=== SKIPPED ===')
for (const [id, why] of skipped) console.log(`  ${id}  ${why}`)

if (!APPLY) {
  console.log(`\nDry run: ${planned.length} sessions would be removed. Re-run with --apply.`)
  process.exit(0)
}

let removed = 0
for (const p of planned) {
  for (const d of p.dirs) {
    try { rmSync(d, { recursive: true, force: true }) }
    catch (error) { console.log(`  WARN could not remove ${d}: ${String(error).slice(0, 60)}`) }
  }
  try { rmSync(p.cachePath, { force: true }) }
  catch (error) { console.log(`  WARN could not remove cache ${p.cachePath}: ${String(error).slice(0, 60)}`) }
  const gone = p.dirs.every(d => !existsSync(d)) && !existsSync(p.cachePath)
  console.log(`  ${gone ? 'REMOVED' : 'PARTIAL'}  ${p.short}`)
  if (gone) removed++
}
console.log(`\n${removed}/${planned.length} blank sessions fully removed.`)
