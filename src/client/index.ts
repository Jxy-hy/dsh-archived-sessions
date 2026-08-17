/**
 * dsh-archived-sessions — browser half: the Settings section that manages
 * the archive set. Listing merges the core session/workspace RPCs with the
 * plugin's host surface; unarchive and delete go through the host surface
 * only, because the core RPC map offers neither operation.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { ArchivedSessionsSection } from './ArchivedSessionsSection.tsx'
import type { ArchivedSessionsSectionInjected } from './ArchivedSessionsSection.tsx'
import { ArchivedSessionsController } from './section-store.ts'
import type { ArchivedRow } from './section-store.ts'
import { t } from './locales.ts'

export type { ArchivedSessionsSectionInjected, ArchivedSessionsSectionProps } from './ArchivedSessionsSection.tsx'
export type { ArchivedRow, ArchivedSessionsState } from './section-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'connection']

/**
 * Mount the settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const section = new ArchivedSessionsController({ api })

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
