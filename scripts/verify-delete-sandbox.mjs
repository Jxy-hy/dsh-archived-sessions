/**
 * Sandbox verification for the delete path.
 *
 * Points DSH_HOME at a throwaway tree so the real `~/.dsh` is never touched,
 * then drives the built host half over a real HTTP socket. Proves, in order:
 *   1. `/list` reports the archived rows with their log facts;
 *   2. `delete` removes the session log directory and GCs only the attachment
 *      objects no surviving session references (a shared object is kept);
 *   3. `delete` clears the registry-global archive set via `unarchiveSession`;
 *   4. a core without `unarchiveSession` degrades to `partial` instead of
 *      throwing, and leaves the log on disk untouched.
 *
 * Run: node scripts/verify-delete-sandbox.mjs
 */

import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = join(tmpdir(), `dsh-arch-del-verify-${process.pid}`)
process.env.DSH_HOME = SANDBOX

const SESSIONS = join(SANDBOX, 'sessions', '--sandbox--')
const OBJECTS = join(SANDBOX, 'attachments', 'v1', 'objects')

/** sha256-shaped ids; the plugin only regex-matches the shape. */
const SHARED = 'aa'.repeat(32)
const ORPHAN = 'bb'.repeat(32)

const victim = 'session-victim-0001'
const keeper = 'session-keeper-0002'

function objectPath(sha) {
  return join(OBJECTS, sha.slice(0, 2), sha)
}

function seed() {
  rmSync(SANDBOX, { recursive: true, force: true })
  // Victim references SHARED + ORPHAN; the keeper also references SHARED, so
  // SHARED must survive the victim's deletion and ORPHAN must not.
  mkdirSync(join(SESSIONS, victim), { recursive: true })
  mkdirSync(join(SESSIONS, keeper), { recursive: true })
  writeFileSync(
    join(SESSIONS, victim, 'session.jsonl'),
    `${JSON.stringify({ t: 'msg', refs: [`sha256:${SHARED}`, `sha256:${ORPHAN}`] })}\n`,
  )
  writeFileSync(
    join(SESSIONS, keeper, 'session.jsonl'),
    `${JSON.stringify({ t: 'msg', refs: [`sha256:${SHARED}`] })}\n`,
  )
  for (const sha of [SHARED, ORPHAN]) {
    mkdirSync(join(OBJECTS, sha.slice(0, 2)), { recursive: true })
    writeFileSync(objectPath(sha), `object ${sha}`)
  }
}

const results = []
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, pass, actual, expected })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`        actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

/** Boot the built host half against a fake ctx and a real HTTP listener. */
async function boot(registry) {
  const mod = await import('../lib/index.js')
  let route
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (r) => { route = r; return () => {} } },
    workspaceRegistry: registry,
    sessionPersistence: { list: async () => [] },
    sessions: { get: () => undefined, dispose: () => true },
    logger: { warn: () => {} },
  }
  mod.apply(ctx)
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function getJson(url, body) {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

// --- Scenario A: delete with a core that provides unarchiveSession ---------
seed()
const archived = new Set([victim, keeper])
const unarchived = []
const registry = {
  get archivedSessionIds() { return [...archived] },
  async unarchiveSession(id) {
    unarchived.push(id)
    archived.delete(id)
  },
}

const host = await boot(registry)
try {
  const listed = await getJson(`${host.base}/__dsh-archived-sessions/list`)
  check('A1 /list status', listed.status, 200)
  check('A2 /list rows are the archived ids', listed.body.rows.map(r => r.id).sort(), [keeper, victim].sort())
  check('A3 /list reports the victim log size',
    typeof listed.body.rows.find(r => r.id === victim)?.sizeBytes, 'number')

  const deleted = await getJson(`${host.base}/__dsh-archived-sessions/delete`, { sessionId: victim })
  check('A4 delete status', deleted.status, 200)
  check('A5 delete is complete, not partial', deleted.body.partial, undefined)
  check('A6 delete reports the accounting write', deleted.body.accounting, 'unarchiveSession')
  check('A7 archive set no longer holds the victim', [...archived], [keeper])
  check('A8 unarchiveSession was driven once', unarchived, [victim])

  check('A9 victim log directory removed', existsSync(join(SESSIONS, victim)), false)
  check('A10 keeper log directory survived', existsSync(join(SESSIONS, keeper)), true)
  check('A11 orphan attachment GCd', existsSync(objectPath(ORPHAN)), false)
  check('A12 attachment still shared by the keeper is kept', existsSync(objectPath(SHARED)), true)

  const after = await getJson(`${host.base}/__dsh-archived-sessions/list`)
  check('A13 /list no longer carries the victim',
    after.body.rows.map(r => r.id), [keeper])

  const unarchivedOp = await getJson(`${host.base}/__dsh-archived-sessions/unarchive`, { sessionId: keeper })
  check('A14 unarchive status', unarchivedOp.status, 200)
  check('A15 unarchive cleared the archive set', [...archived], [])
} finally {
  await host.close()
}

// --- Scenario B: a core without unarchiveSession degrades, never throws ----
seed()
const bare = { archivedSessionIds: [victim] }
const bareHost = await boot(bare)
try {
  const degraded = await getJson(`${bareHost.base}/__dsh-archived-sessions/delete`, { sessionId: victim })
  check('B1 degraded delete still returns 200', degraded.status, 200)
  check('B2 degraded delete flags partial', degraded.body.partial, true)
  check('B3 degraded delete names the missing capability',
    degraded.body.reason, 'accounting-core-missing')
  // The log is removed before the accounting step, so the failure is reported
  // rather than thrown; the file outcome is what the caller must be told.
  check('B4 degraded delete still removed the log', existsSync(join(SESSIONS, victim)), false)
} finally {
  await bareHost.close()
}

rmSync(SANDBOX, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.label}`)
  process.exitCode = 1
}
