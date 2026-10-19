/**
 * dsh-archived-sessions — host half.
 *
 * A same-origin HTTP surface under `/__dsh-archived-sessions` that performs
 * the two session operations the core RPC surface does not offer:
 *
 * - `GET /list` — archived session ids with the per-session facts the
 *   browser needs (cwd, created time, log path, log size).
 * - `POST /unarchive` — remove a session from the workspace registry's
 *   archive set, restoring it in every grouping surface.
 * - `POST /delete` — permanently remove the session's on-disk artifacts
 *   (its log directory under `<dshHome>/sessions`, plus any attachment
 *   objects the log references that no OTHER remaining session references)
 *   and drop the session from workspace accounting.
 *
 * The browser half (`src/client`) renders the Settings section and calls
 * this surface with same-origin fetch; no new RPC method is added anywhere.
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the ctx.sessions merge (the live SessionStore).
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'

export const name = 'dsh-archived-sessions'
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions']

const ROUTE_PREFIX = '/__dsh-archived-sessions'
/** Canonical attachment references appear in logs as `sha256:<64 hex>`. */
const ATTACHMENT_ID = /sha256:([a-f0-9]{64})/g
const MAX_BODY_BYTES = 64 * 1024

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function sessionsRoot(): string {
  return join(dshHome(), 'sessions')
}

/**
 * One session's persisted projection-cache row. The session listing serves its
 * projection column from these rows (keyed by the bare session id), so a row
 * left behind after the log is gone keeps the session listed forever — and
 * because delete also clears the archive set, the survivor reappears as an
 * ordinary unarchived conversation instead of vanishing.
 */
function projectionCachePath(sessionId: string): string {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/**
 * Remove a session's projection-cache row. The row is pure derived state — a
 * checkpoint rebuilt from the log on the next cold read — so dropping it is
 * always safe, and it is the only way to forget a session the core no longer
 * has a log for: `sessionProjectionCache` exposes writes and reads but no
 * removal, and its `session/disposed` handler only flushes.
 * @param sessionId - session whose cached row is dropped.
 * @returns the removed path when a row existed.
 */
async function dropProjectionCache(sessionId: string): Promise<string | undefined> {
  const path = projectionCachePath(sessionId)
  try {
    await rm(path, { force: true })
  } catch {
    // A missing or unreadable row is not a reason to fail the deletion; the
    // log is already gone, so the row would be rebuilt as empty at worst.
    return undefined
  }
  return path
}

function attachmentObjectPath(sha256: string): string {
  return join(dshHome(), 'attachments', 'v1', 'objects', sha256.slice(0, 2), sha256)
}

function isLogName(name: string): boolean {
  return name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')
}

/**
 * Session-format generation of one log artifact name: `session.jsonl[.zstd]`
 * is generation 0, `session.vN.jsonl[.zstd]` is generation N. JSONL
 * persistence publishes every format migration as its own immutable file, so a
 * migrated session keeps its original generation beside the successor.
 */
function logGeneration(fileName: string): number {
  const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(fileName)
  const version = match?.[1]
  return version === undefined ? 0 : Number(version)
}

/**
 * Locate one session's newest log artifact under the sessions root. The layout
 * is `<root>/<workspace-segment>/<sessionId>/<generation file>`; the highest
 * generation carries the session's current events, and the enclosing directory
 * holds every retained generation.
 */
async function findSessionLog(sessionId: string): Promise<string | undefined> {
  const candidates: { path: string; generation: number }[] = []
  try {
    const entries = await readdir(sessionsRoot(), { recursive: true })
    for (const entry of entries) {
      if (!isLogName(entry)) continue
      const parts = entry.split(/[\\/]+/)
      if (parts.length < 2 || parts[parts.length - 2] !== sessionId) continue
      candidates.push({
        path: join(sessionsRoot(), entry),
        generation: logGeneration(parts[parts.length - 1] ?? ''),
      })
    }
  } catch {
    return undefined
  }
  candidates.sort((left, right) =>
    right.generation - left.generation || left.path.localeCompare(right.path))
  return candidates[0]?.path
}

/** Decode a log artifact to plaintext; a torn or incompatible artifact yields undefined. */
async function plaintextOf(logPath: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(logPath)
    try {
      return zstdDecompressSync(buffer).toString('utf8')
    } catch {
      // An uncompressed (.jsonl) artifact is not a zstd frame; fall through.
      return buffer.toString('utf8')
    }
  } catch {
    return undefined
  }
}

/** Every attachment object hash a session log references, deduplicated. */
function attachmentIdsOf(plaintext: string): string[] {
  const ids = new Set<string>()
  ATTACHMENT_ID.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTACHMENT_ID.exec(plaintext)) !== null) {
    const hash = match[1]
    if (hash !== undefined) ids.add(hash)
  }
  return [...ids]
}

/**
 * Whether any session log OTHER than `exceptSessionId` references the object.
 * A log that cannot be decoded counts as referencing it — deleting a shared
 * object would break a live session, so doubt must keep the file.
 */
async function referencedElsewhere(sha256: string, exceptSessionId: string): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(sessionsRoot(), { recursive: true })
  } catch {
    return true
  }
  const needle = `sha256:${sha256}`
  for (const entry of entries) {
    if (!isLogName(entry)) continue
    const parts = entry.split(/[\\/]+/)
    if (parts.length < 2 || parts[parts.length - 2] === exceptSessionId) continue
    const text = await plaintextOf(join(sessionsRoot(), entry))
    if (text !== undefined && text.includes(needle)) return true
  }
  return false
}

/** Session facts this surface reads out of a persistence listing. */
interface SessionHeaderFacts {
  id: string
  cwd?: string
  createdAt?: number
}

/**
 * Normalize one `sessionPersistence.list()` row to the header facts this
 * surface needs. Session-format V3 (harness 0.1.5) returns
 * `SessionPersistenceSnapshot` objects — `{ header, revision, … }` — while
 * earlier builds returned the bare header, so both generations are accepted
 * and a row carrying neither shape is dropped.
 */
function headerFactsOf(row: unknown): SessionHeaderFacts | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const record = row as { header?: unknown }
  const source = (record.header !== null && typeof record.header === 'object'
    ? record.header
    : record) as { id?: unknown; cwd?: unknown; createdAt?: unknown }
  if (typeof source.id !== 'string') return undefined
  return {
    id: source.id,
    ...(typeof source.cwd === 'string' ? { cwd: source.cwd } : {}),
    ...(typeof source.createdAt === 'number' ? { createdAt: source.createdAt } : {}),
  }
}

/** Whether the running registry build offers the extended accounting methods. */
function coreMethodsPresent(registry: unknown, method: string): boolean {
  return typeof (registry as Record<string, unknown> | null)?.[method] === 'function'
}

async function handleList(ctx: Context): Promise<unknown> {
  const ids = ctx.workspaceRegistry.archivedSessionIds
  let headers: readonly SessionHeaderFacts[] = []
  try {
    const listed = await ctx.sessionPersistence.list() as unknown as readonly unknown[]
    headers = listed.map(headerFactsOf).filter((row): row is SessionHeaderFacts => row !== undefined)
  } catch {
    // Persistence listing is advisory; the archive set itself still answers.
  }
  const byId = new Map(headers.map(header => [header.id, header]))
  const rows: unknown[] = []
  for (const id of ids) {
    const header = byId.get(id)
    const logPath = await findSessionLog(id)
    let sizeBytes: number | undefined
    if (logPath !== undefined) {
      try {
        sizeBytes = (await stat(logPath)).size
      } catch {
        // The log vanished between the scan and the stat; size stays unknown.
      }
    }
    rows.push({ id, cwd: header?.cwd, createdAt: header?.createdAt, logPath, sizeBytes })
  }
  return { ok: true, rows }
}

async function handleUnarchive(ctx: Context, sessionId: string): Promise<unknown> {
  const registry = ctx.workspaceRegistry as unknown
  if (!coreMethodsPresent(registry, 'unarchiveSession')) {
    return {
      ok: false,
      error: 'core-outdated',
      message: 'unarchiveSession is not available in the running core — restart `dsh web` to activate the plugin support',
    }
  }
  await (registry as { unarchiveSession: (id: string) => Promise<void> }).unarchiveSession(sessionId)
  return { ok: true, sessionId }
}

async function handleDelete(ctx: Context, sessionId: string): Promise<unknown> {
  const registry = ctx.workspaceRegistry as unknown
  const archived = (ctx.workspaceRegistry.archivedSessionIds as readonly string[]).includes(sessionId)
  // A live (attached) session counts as present even without artifacts: it
  // must still be disposed and dropped from accounting, so an already
  // file-less session left over from an earlier partial deletion can be
  // cleaned up instead of lingering in the sidebar.
  const live = (ctx.sessions as unknown as { get: (id: string) => unknown }).get(sessionId)
  let logPath = await findSessionLog(sessionId)
  if (!archived && logPath === undefined && live === undefined) {
    return { ok: false, error: 'session-not-found', message: `no archived or stored session '${sessionId}'` }
  }

  // 0) Dispose the live session FIRST: detach it from the in-memory store
  // (emitting session/disposed so persistence retires its state). Without
  // this, a previously-opened session stays listed by session.list and
  // reappears under "Ungrouped" in the sidebar after deletion.
  let disposed = false
  if (live !== undefined) {
    const sessions = ctx.sessions as unknown as { dispose?: (id: string) => boolean }
    if (typeof sessions.dispose === 'function') {
      disposed = sessions.dispose(sessionId)
    }
    // The retirement flush drains the session's write-behind buffer, so a
    // just-created session's log may only materialize AFTER disposal (the
    // file can lag the create RPC by up to the write-batching window). Wait
    // for the artifact before scanning for attachments and deleting.
    if (logPath === undefined) {
      for (let attempt = 0; attempt < 20 && logPath === undefined; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        logPath = await findSessionLog(sessionId)
      }
    }
  }

  // 1) Remove on-disk artifacts: the session log directory, then every
  // attachment object this log references that no other session still uses.
  let removedLog: string | undefined
  const removedAttachments: string[] = []
  if (logPath !== undefined) {
    const sessionDir = dirname(logPath)
    const own = attachmentIdsOf((await plaintextOf(logPath)) ?? '')
    try {
      await rm(sessionDir, { recursive: true, force: true })
      removedLog = sessionDir
    } catch (error) {
      return { ok: false, error: 'delete-failed', message: String(error) }
    }
    for (const sha256 of own) {
      if (await referencedElsewhere(sha256, sessionId)) continue
      try {
        await rm(attachmentObjectPath(sha256), { force: true })
        removedAttachments.push(attachmentObjectPath(sha256))
      } catch {
        // An unreadable/vanished object must not fail the whole deletion.
      }
    }
  }

  // 2) Drop the persisted projection-cache row. The session listing builds its
  // projection column from these rows, so a surviving row keeps the session
  // listed even though its log is gone. Drop it BEFORE clearing the archive
  // set: otherwise the row stays visible and, with the archive bit already
  // cleared, surfaces as an ordinary unarchived conversation — the exact
  // "delete leaves it in the sidebar, no longer archived" failure.
  const removedCache = await dropProjectionCache(sessionId)

  // 3) Drop the workspace accounting. The owning workspace's `sessionIds`
  // needed no explicit write even before this: its getter is already filtered
  // by the startup/live canonical-cwd header index, so removing the log drops
  // the session from the workspace projection by itself. What genuinely had to
  // be cleared is the registry-global archive set, and `unarchiveSession` is
  // exactly that write: it drops the id from `archivedSessionIds` and touches
  // no accounting slot. It runs no session-existence check (removing an id
  // cannot introduce an unknown one) and no-ops on an id that is not archived,
  // so an already-clean session still resolves.
  if (!coreMethodsPresent(registry, 'unarchiveSession')) {
    return {
      ok: true,
      partial: true,
      reason: 'accounting-core-missing',
      message: 'files removed, but clearing the archive set needs a core that provides workspaceRegistry.unarchiveSession',
      removedLog,
      removedCache,
      removedAttachments,
    }
  }
  await (registry as { unarchiveSession: (id: string) => Promise<void> }).unarchiveSession(sessionId)
  return {
    ok: true,
    disposed,
    removedLog,
    removedCache,
    removedAttachments,
    accounting: 'unarchiveSession',
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function handleRoute(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh')
    const path = url.pathname.replace(/\/+$/, '') || ROUTE_PREFIX
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === ROUTE_PREFIX) {
      sendJson(res, 200, { ok: true, name, operations: ['list', 'unarchive', 'delete'] })
      return
    }
    if (method === 'GET' && path === `${ROUTE_PREFIX}/list`) {
      sendJson(res, 200, await handleList(ctx))
      return
    }
    if (method === 'POST' && (path === `${ROUTE_PREFIX}/unarchive` || path === `${ROUTE_PREFIX}/delete`)) {
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req)) as unknown
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad-json' })
        return
      }
      const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        sendJson(res, 400, { ok: false, error: 'missing-sessionId' })
        return
      }
      sendJson(res, 200, path === `${ROUTE_PREFIX}/delete`
        ? await handleDelete(ctx, sessionId)
        : await handleUnarchive(ctx, sessionId))
      return
    }
    sendJson(res, 404, { ok: false, error: 'not-found' })
  } catch (error) {
    ctx.logger.warn(`dsh-archived-sessions: ${String(error)}`)
    sendJson(res, 500, { ok: false, error: 'internal', message: String(error) })
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => handleRoute(ctx, req, res),
  }), 'dsh-archived-sessions: http surface')
}
