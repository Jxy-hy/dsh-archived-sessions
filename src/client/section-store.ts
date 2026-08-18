/**
 * Archived-sessions management controller: the archive set as rows, plus the
 * two host operations — unarchive (restore to the sidebar) and delete
 * (permanent, file removal included, behind a confirmation dialog).
 *
 * The host stays the single fact source. The page lists by merging the core
 * `session.list`/`workspace.list` RPCs (titles, update times) with the
 * plugin's `/__dsh-archived-sessions/list` surface (creation time, log size),
 * and every mutation goes through the plugin's HTTP surface because the core
 * RPC map has no unarchive/delete methods.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** The slice of the connection the controller needs. */
export type ArchivedSessionsConnection = Pick<ConnectionHandle, 'api'> & {
  /**
   * Re-pull the Host session-list baseline after a delete. Deleting a cold
   * (persisted, not-open) session never fires `session/disposed`, so the
   * browser never receives `host/session-removed` for it; dropping it from
   * the archive set merely un-hides the stale row as Ungrouped. Refreshing
   * prunes rows absent from the fresh baseline.
   */
  refreshSessionList: () => Promise<void>
}

/** One archived-session row the page renders. */
export interface ArchivedRow {
  /** Session id (the durable key). */
  id: string
  /** Human-facing label: durable title, workspace basename, then short id. */
  displayTitle: string
  /** Working directory the session was created in, when known. */
  cwd?: string
  /** Last-activity epoch ms (host summary), when known. */
  updatedAt?: number
  /** Creation epoch ms (persistence header), when known. */
  createdAt?: number
  /** Log artifact size in bytes, when the log is present. */
  sizeBytes?: number
}

/** Page snapshot. */
export interface ArchivedSessionsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; a per-action failure stays on the row/dialog. */
  error: string | null
  rows: readonly ArchivedRow[]
  /** Sessions with an unarchive in flight. */
  unarchiving: ReadonlySet<string>
  /** The row awaiting delete confirmation, or null. */
  pendingDelete: ArchivedRow | null
  /** Whether a delete is in flight. */
  deleting: boolean
  /** The last delete failure, cleared by the next dialog action. */
  deleteError: string | null
}

const INITIAL: ArchivedSessionsState = {
  status: 'idle',
  error: null,
  rows: [],
  unarchiving: new Set(),
  pendingDelete: null,
  deleting: false,
  deleteError: null,
}

/** Wire row of `session.list` (titles/update times). The durable title rides
 * the projection block's `values.title` key — the same source the sidebar
 * names sessions from — never a top-level field. */
interface SessionListWireRow {
  sessionId: string
  updatedAt?: number
  title?: string
  cwd?: string
  projections?: {
    values?: {
      title?: string | null
    }
  }
}

/** Wire row of the plugin's `/list` surface (creation time, log facts). */
interface HostListWireRow {
  id: string
  cwd?: string
  createdAt?: number
  logPath?: string
  sizeBytes?: number
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

function displayTitleOf(title: string | undefined, cwd: string | undefined, id: string): string {
  if (title !== undefined && title.length > 0) return title
  if (cwd !== undefined && cwd.length > 0) return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
  return shortId(id)
}

export class ArchivedSessionsController {
  readonly hooks: SnapshotStore<ArchivedSessionsState>

  constructor(private readonly connection: ArchivedSessionsConnection) {
    this.hooks = createSnapshotStore(INITIAL)
  }

  private async fetchHost<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, body === undefined
      ? undefined
      : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    return await response.json() as T
  }

  async load(): Promise<void> {
    const snapshot = this.hooks.getSnapshot()
    if (snapshot.status === 'loading') return
    this.hooks.set({ ...snapshot, status: 'loading', error: null })
    try {
      const [sessionResult, workspaceResult, hostResult] = await Promise.all([
        this.connection.api.sessions.list({}),
        this.connection.api.workspace.list({}),
        this.fetchHost<{ ok: boolean; rows?: HostListWireRow[] }>('/__dsh-archived-sessions/list'),
      ])
      if (!sessionResult.result.ok || !workspaceResult.result.ok) {
        throw new Error('session/workspace listing failed')
      }
      const archivedIds = new Set<string>(
        workspaceResult.result.value.archivedSessionIds as unknown as string[])
      const byId = new Map<string, SessionListWireRow>()
      for (const item of sessionResult.result.value.items) {
        byId.set(item.sessionId, item as unknown as SessionListWireRow)
      }
      const hostById = new Map<string, HostListWireRow>()
      for (const row of hostResult.rows ?? []) hostById.set(row.id, row)

      const rows: ArchivedRow[] = []
      for (const id of archivedIds) {
        const session = byId.get(id)
        const host = hostById.get(id)
        const cwd = session?.cwd ?? host?.cwd
        const updatedAt = session?.updatedAt
        const createdAt = host?.createdAt
        const sizeBytes = host?.sizeBytes
        // The session's own name (projection `values.title`, matching the
        // sidebar) wins; the workspace basename is only a fallback for
        // sessions that never gained a title.
        const title = session?.projections?.values?.title ?? session?.title ?? undefined
        rows.push({
          id,
          displayTitle: displayTitleOf(title, cwd, id),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        })
      }
      rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      this.hooks.set({ ...this.hooks.getSnapshot(), status: 'ready', rows })
    } catch (error) {
      this.hooks.set({
        ...this.hooks.getSnapshot(),
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async unarchive(id: string): Promise<void> {
    const snapshot = this.hooks.getSnapshot()
    if (snapshot.unarchiving.has(id)) return
    this.hooks.set({ ...snapshot, unarchiving: new Set(snapshot.unarchiving).add(id), error: null })
    try {
      const result = await this.fetchHost<{ ok: boolean; error?: string; message?: string }>(
        '/__dsh-archived-sessions/unarchive', { sessionId: id })
      if (!result.ok) throw new Error(result.message ?? result.error ?? 'unarchive failed')
      await this.load()
    } catch (error) {
      this.hooks.set({
        ...this.hooks.getSnapshot(),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      // Clear the in-flight marker on BOTH outcomes. Previously the id was
      // only removed on the failure path, so a successful unarchive left a
      // stale `unarchiving` entry that permanently disabled this row's
      // unarchive AND delete buttons (both bind to `unarchiving.has(id)`)
      // once the session reappeared in the list, e.g. after a re-archive.
      this.hooks.set({
        ...this.hooks.getSnapshot(),
        unarchiving: new Set([...this.hooks.getSnapshot().unarchiving].filter(x => x !== id)),
      })
    }
  }

  confirmDelete(row: ArchivedRow | null): void {
    this.hooks.set({ ...this.hooks.getSnapshot(), pendingDelete: row, deleteError: null })
  }

  async remove(): Promise<void> {
    const snapshot = this.hooks.getSnapshot()
    const target = snapshot.pendingDelete
    if (target === null || snapshot.deleting) return
    this.hooks.set({ ...snapshot, deleting: true, deleteError: null })
    try {
      const result = await this.fetchHost<{ ok: boolean; error?: string; message?: string }>(
        '/__dsh-archived-sessions/delete', { sessionId: target.id })
      if (!result.ok) throw new Error(result.message ?? result.error ?? 'delete failed')
      this.hooks.set({ ...this.hooks.getSnapshot(), deleting: false, pendingDelete: null })
      await this.load()
      // The deleted cold session cannot have fired a session-removed frame,
      // so re-pull the Host session list to drop its stale Ungrouped row.
      await this.connection.refreshSessionList()
    } catch (error) {
      this.hooks.set({
        ...this.hooks.getSnapshot(),
        deleting: false,
        deleteError: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
