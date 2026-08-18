/**
 * dsh-archived-sessions — browser half: the Settings section that manages
 * the archive set. Listing merges the core session/workspace RPCs with the
 * plugin's host surface; unarchive and delete go through the host surface
 * only, because the core RPC map offers neither operation.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { type ClientContext, type SessionRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import { ArchivedSessionsSection } from './ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionInjected } from './ArchivedSessionsSection.tsx'
import { ArchivedSessionsController } from './section-store.ts'
import type { ArchivedRow } from './section-store.ts'
import { t } from './locales.ts'

export type { ArchivedSessionsSectionInjected, ArchivedSessionsSectionProps } from './ArchivedSessionsSection.tsx'
export type { ArchivedRow, ArchivedSessionsState } from './section-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'connection', 'sessions']

/**
 * Mount the settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  // The client runtime provides the concrete SessionRuntime under 'sessions'
  // (its Context augmentation is narrow ISessions, and the stack also hosts a
  // SessionStore by that name on the host plane), so the refresh face is
  // reached through the concrete type.
  const sessions = ctx.get('sessions') as unknown as SessionRuntime
  const section = new ArchivedSessionsController({
    api: connection.api,
    refreshSessionList: () => sessions.refresh(),
  })

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
