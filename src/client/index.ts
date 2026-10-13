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
  const connection: ArchivedSessionsConnection = {
    sessions: remote.session,
    workspaces,
    refreshSessionList: () => sessions.refresh(),
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
