/**
 * dsh-archived-sessions — browser half: the Settings section that manages
 * the archive set. Listing merges the core session/workspace RPCs with the
 * plugin's host surface; unarchive and delete go through the host surface
 * only, because the core RPC map offers neither operation.
 */

// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer-owned Context augmentation that declares the
// `ctx.slots` SlotRegistry service. It lives in the /client entry — the root
// entry exports only the framework-neutral core and augments nothing.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { ArchivedSessionsSection } from './ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionInjected } from './ArchivedSessionsSection.tsx'
import { ArchivedSessionsController } from './section-store.ts'
import type { ArchivedRow, ArchivedSessionsConnection } from './section-store.ts'
import { t } from './locales.ts'

export type { ArchivedSessionsSectionInjected, ArchivedSessionsSectionProps } from './ArchivedSessionsSection.tsx'
export type { ArchivedRow, ArchivedSessionsState } from './section-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'sessions', 'remote', 'remote.session', 'workspaces']

/**
 * Mount the settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // The session-controller client provides the concrete ClientSessions under
  // 'sessions' (Context augments it to ISessions, but another package declares
  // a SessionStore by that name too, so the concrete face is reached through
  // the get cast); its refresh() re-pulls the Host session-list baseline,
  // which prunes rows for cold-session deletes.
  const sessions = ctx.get('sessions') as unknown as ISessions
  // The generated Remote service replaced the former connection.api surface,
  // and the live workspace snapshot carries the archive set.
  // The generated Remote namespace is `remote.session` (singular); the
  // controller keeps the plural `sessions` face name for its listing role.
  const remote = ctx.get('remote') as unknown as { session: ArchivedSessionsConnection['sessions'] }
  const workspaces = ctx.get('workspaces') as unknown as ArchivedSessionsConnection['workspaces']

  // Re-pull the Host session-list baseline. The core emits `api-session/removed`
  // only from its `session/disposed` handler, so a deleted COLD session (stored,
  // never opened) produces no removal event at all — this pull is the only thing
  // that prunes its row from the sidebar. Resolve it defensively: if the service
  // face is missing the refresh must degrade to a reported no-op rather than
  // throw, because a throw here used to abort the whole post-delete cleanup and
  // leave the row on screen.
  const refreshSessionList = async (): Promise<void> => {
    const refresh = (sessions as unknown as { refresh?: () => unknown } | undefined)?.refresh
    if (typeof refresh !== 'function') {
      throw new Error('session-list refresh is unavailable in this harness build')
    }
    await refresh.call(sessions)
  }

  const connection: ArchivedSessionsConnection = {
    sessions: remote.session,
    workspaces,
    refreshSessionList,
    // The sidebar renders from this list; asking it directly is the only
    // reliable way to know whether a deleted row is really off screen.
    isSessionListed: (id: string): boolean => {
      const list = (sessions as unknown as {
        list?: { getSnapshot?: () => { byId?: Record<string, unknown> } }
      }).list
      const snapshot = list?.getSnapshot?.()
      return snapshot?.byId?.[id] !== undefined
    },
  }
  const section = new ArchivedSessionsController(connection)

  const sectionInjected = (): ArchivedSessionsSectionInjected => ({
    hooks: {
      archivedSessions: section.hooks,
    },
    load: () => section.load(),
    unarchive: (id: string) => section.unarchive(id),
    confirmDelete: (row: ArchivedRow | null) => { section.confirmDelete(row) },
    remove: () => section.remove(),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'archived-sessions',
    order: 30,
    label: () => t('nav'),
    inject: sectionInjected,
  }, ArchivedSessionsSection))
}
