/**
 * dsh-archived-sessions host smoke test — boots the built host plugin on a
 * minimal fake cordis context + real HTTP server, and exercises /list,
 * /unarchive and /delete against a throwaway DSH_HOME sessions tree.
 *
 * The regression this guards: deleting an archived session must remove its
 * on-disk log AND drop workspace accounting, for BOTH a live session (which
 * must first be disposed) and a cold persisted session. After /delete, a
 * fresh session.list baseline (what the client's `sessions.refresh()` re-pulls)
 * must no longer contain the session — otherwise the browser keeps the stale
 * row under Ungrouped until reconnect.
 *
 * Run: node scripts/smoke-test.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let failures = 0

function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { console.error(`  ✗ FAIL: ${label}`); failures += 1 }
}

/** One archived session id per scenario. */
const COLD_ID = 'session-cold-0001-0000-0000-000000000001'
const LIVE_ID = 'session-live-0002-0000-0000-000000000002'
const PROJECT = 'tmp-project'
const PROJECT_DIR = `--${PROJECT}--`

function sessionLogPath(root, id) {
  return join(root, PROJECT_DIR, id, 'session.jsonl')
}

/** Minimal plaintext JSONL header (the backend accepts uncompressed .jsonl). */
function headerLine(id) {
  return `${JSON.stringify({ version: 0, id, createdAt: Date.now(), cwd: `/tmp/${PROJECT}` })}\n`
}

/**
 * Boot the plugin on a fake ctx with the services it injects. The webServer
 * route is mounted on a real HTTP server; the registry/sessions calls are
 * recorded so the test can assert what /delete actually did.
 */
function boot(options) {
  const routes = []
  const calls = { disposed: [], deleteSession: [], unarchiveSession: [] }
  const fakeCtx = {
    logger: { warn: (...a) => console.warn('  [host.warn]', ...a) },
    effect: (fn) => typeof fn() === 'function' ? () => {} : () => {},
    webServer: {
      register: (route) => { routes.push(route); return () => {} },
    },
    workspaceRegistry: {
      archivedSessionIds: options.archivedSessionIds,
      unarchiveSession: async (id) => { calls.unarchiveSession.push(id) },
      deleteSession: async (id) => {
        calls.deleteSession.push(id)
        return { workspaceId: undefined, wasArchived: true }
      },
    },
    sessionPersistence: {
      list: async () => [], // advisory; the archive set alone answers
    },
    sessions: {
      get: (id) => options.liveSessions.includes(id) ? { id } : undefined,
      dispose: (id) => { calls.disposed.push(id); return true },
      list: () => [],
    },
  }
  apply(fakeCtx, {})
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.find((r) => pathname === r.path || pathname.startsWith(`${r.path}/`))
    if (route !== undefined) route.handler(req, res)
    else { res.writeHead(404); res.end('not found') }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      calls,
      close: () => new Promise((done) => server.close(done)),
    }))
  })
}

async function call(base, path, method = 'GET', body) {
  const res = await fetch(`${base}${path}`, body === undefined
    ? undefined
    : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 200) } }
  return { status: res.status, json }
}

/** Create a throwaway DSH_HOME with `ids` as plaintext .jsonl logs. */
function makeHome(ids) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  for (const id of ids) {
    const dir = join(home, 'sessions', PROJECT_DIR, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(sessionLogPath(join(home, 'sessions'), id),
      `${headerLine(id)}${JSON.stringify({ type: 'user/message', seq: 0, time: Date.now(), data: { hello: 'world' } })}\n`)
  }
  return home
}

/** A fresh session.list baseline as the host would compute it: live + persisted. */
async function freshBaseline(home) {
  const persisted = []
  const sessionsRoot = join(home, 'sessions')
  if (existsSync(sessionsRoot)) {
    for (const project of await import('node:fs/promises').then(m => m.readdir(sessionsRoot))) {
      const projectDir = join(sessionsRoot, project)
      if (!(await import('node:fs/promises').then(m => m.stat(projectDir))).isDirectory()) continue
      for (const id of await import('node:fs/promises').then(m => m.readdir(projectDir))) {
        if (existsSync(join(projectDir, id, 'session.jsonl'))) persisted.push(id)
      }
    }
  }
  return persisted
}

async function main() {
  console.log('== 1. cold archived session: /delete removes log + accounting ==')
  const homeCold = makeHome([COLD_ID])
  process.env.DSH_HOME = homeCold
  const bootCold = await boot({ archivedSessionIds: [COLD_ID], liveSessions: [] })

  let r = await call(bootCold.base, '/__dsh-archived-sessions/list')
  assert(r.status === 200, `list HTTP 200 (got ${r.status})`)
  assert(r.json.rows?.length === 1 && r.json.rows[0].id === COLD_ID, 'cold archived session listed')
  assert(typeof r.json.rows[0].sizeBytes === 'number', 'list carries log size')

  r = await call(bootCold.base, '/__dsh-archived-sessions/delete', 'POST', { sessionId: COLD_ID })
  assert(r.status === 200, `delete HTTP 200 (got ${r.status})`)
  assert(r.json.ok === true, 'delete ok')
  assert(r.json.disposed === false, 'cold session was not disposed (nothing to dispose)')
  assert(!existsSync(join(homeCold, 'sessions', PROJECT_DIR, COLD_ID)), 'log directory removed from disk')
  assert(bootCold.calls.deleteSession.includes(COLD_ID), 'workspace accounting deleteSession called')
  assert(bootCold.calls.disposed.length === 0, 'no dispose for the cold session')

  const baselineCold = await freshBaseline(homeCold)
  assert(!baselineCold.includes(COLD_ID), 'fresh session.list baseline no longer contains the deleted session')
  await bootCold.close()

  console.log('\n== 2. live archived session: /delete disposes then removes files ==')
  const homeLive = makeHome([LIVE_ID])
  process.env.DSH_HOME = homeLive
  const bootLive = await boot({ archivedSessionIds: [LIVE_ID], liveSessions: [LIVE_ID] })

  r = await call(bootLive.base, '/__dsh-archived-sessions/delete', 'POST', { sessionId: LIVE_ID })
  assert(r.status === 200, `delete HTTP 200 (got ${r.status})`)
  assert(r.json.ok === true, 'delete ok')
  assert(r.json.disposed === true, 'live session was disposed')
  assert(bootLive.calls.disposed.includes(LIVE_ID), 'ctx.sessions.dispose called for the live session')
  assert(!existsSync(join(homeLive, 'sessions', PROJECT_DIR, LIVE_ID)), 'log directory removed from disk')
  assert(bootLive.calls.deleteSession.includes(LIVE_ID), 'workspace accounting deleteSession called')

  const baselineLive = await freshBaseline(homeLive)
  assert(!baselineLive.includes(LIVE_ID), 'fresh session.list baseline no longer contains the deleted live session')
  await bootLive.close()

  console.log('\n== 3. unarchive + unknown-session guard ==')
  const homeU = makeHome([COLD_ID])
  process.env.DSH_HOME = homeU
  const bootU = await boot({ archivedSessionIds: [COLD_ID, LIVE_ID], liveSessions: [] })
  r = await call(bootU.base, '/__dsh-archived-sessions/unarchive', 'POST', { sessionId: COLD_ID })
  assert(r.status === 200, `unarchive HTTP 200 (got ${r.status})`)
  assert(r.json.ok === true, 'unarchive ok')
  assert(bootU.calls.unarchiveSession.includes(COLD_ID), 'registry unarchiveSession called')
  assert(bootU.calls.deleteSession.length === 0, 'unarchive does not delete')
  assert(bootU.calls.disposed.length === 0, 'unarchive does not dispose')

  r = await call(bootU.base, '/__dsh-archived-sessions/delete', 'POST', { sessionId: 'session-unknown' })
  assert(r.status === 200, `unknown delete HTTP 200 (got ${r.status})`)
  assert(r.json.ok === false && r.json.error === 'session-not-found', 'unknown id reported session-not-found')
  await bootU.close()

  console.log('\n== done ==')
  process.env.DSH_HOME = undefined
  for (const dir of [homeCold, homeLive, homeU]) rmSync(dir, { recursive: true, force: true })
  if (failures > 0) { console.error(`${failures} assertion(s) failed`); process.exitCode = 1 }
  else console.log('all assertions passed')
}

main().catch((error) => {
  console.error('smoke test crashed:', error)
  process.exitCode = 1
})
