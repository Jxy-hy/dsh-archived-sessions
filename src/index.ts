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
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'

export const name = 'dsh-archived-sessions'
export const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence']

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

function attachmentObjectPath(sha256: string): string {
  return join(dshHome(), 'attachments', 'v1', 'objects', sha256.slice(0, 2), sha256)
}

function isLogName(name: string): boolean {
  return name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')
}

/**
 * Locate one session's log artifact under the sessions root. The layout is
 * `<root>/<workspace-segment>/<sessionId>/session.jsonl[.zstd]`.
 */
async function findSessionLog(sessionId: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(sessionsRoot(), { recursive: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!isLogName(entry)) continue
    const parts = entry.split(/[\\/]+/)
    if (parts.length < 2 || parts[parts.length - 2] !== sessionId) continue
    return join(sessionsRoot(), entry)
  }
  return undefined
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

/** Whether the running registry build offers the extended accounting methods. */
function coreMethodsPresent(registry: unknown, method: string): boolean {
  return typeof (registry as Record<string, unknown> | null)?.[method] === 'function'
}

async function handleList(ctx: Context): Promise<unknown> {
  const ids = ctx.workspaceRegistry.archivedSessionIds
  let headers: readonly { id: string; cwd?: string; createdAt?: number }[] = []
  try {
    headers = await ctx.sessionPersistence.list() as unknown as readonly {
      id: string; cwd?: string; createdAt?: number
    }[]
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
  const logPath = await findSessionLog(sessionId)
  if (!archived && logPath === undefined) {
    return { ok: false, error: 'session-not-found', message: `no archived or stored session '${sessionId}'` }
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

  // 2) Drop workspace accounting (archive set + owning workspace sessionIds).
  if (!coreMethodsPresent(registry, 'deleteSession')) {
    return {
      ok: true,
      partial: true,
      reason: 'accounting-core-missing',
      message: 'files removed, but registry accounting needs a `dsh web` restart to pick up the new core',
      removedLog,
      removedAttachments,
    }
  }
  const accounting = await (registry as { deleteSession: (id: string) => Promise<unknown> }).deleteSession(sessionId)
  return { ok: true, removedLog, removedAttachments, accounting }
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
