/**
 * Archived-sessions settings section: the archive set as rows with two
 * actions per row — unarchive (restore to the sidebar) and delete
 * (permanent, behind a confirmation dialog). The list merges the core
 * session/workspace RPCs with the plugin's host surface; both mutations go
 * through the host surface because the core RPC map offers neither.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconRefreshOutline16, IconTrashOutline16, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArchivedRow, ArchivedSessionsState } from './section-store.ts'
import { t } from './locales.ts'
import css from './ArchivedSessionsSection.module.css'

/** Registration-side business face for the management section. */
export interface ArchivedSessionsSectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useArchivedSessions. */
    archivedSessions: SnapshotStore<ArchivedSessionsState>
  }
  /** Read the archive set; called once when the section first renders. */
  load: () => Promise<void>
  /** Restore one archived session to the sidebar. */
  unarchive: (id: string) => Promise<void>
  /** Ask for delete confirmation on one row, or dismiss it with null. */
  confirmDelete: (row: ArchivedRow | null) => void
  /** Delete the row awaiting confirmation. */
  remove: () => Promise<void>
}

/** Full component props. */
export type ArchivedSessionsSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<ArchivedSessionsSectionInjected>

/** Format an epoch-ms timestamp with the browser locale. */
function formatTime(epochMs: number | undefined): string {
  if (epochMs === undefined || Number.isNaN(epochMs)) return '—'
  return new Date(epochMs).toLocaleString()
}

/** Compact byte count, e.g. "330 KB". */
function formatSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || Number.isNaN(bytes)) return undefined
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Render the Archived sessions section content column.
 * @param props - composed slot props.
 * @returns the section content.
 */
export function ArchivedSessionsSection(props: ArchivedSessionsSectionProps): ReactNode {
  const { useArchivedSessions, load } = props
  const state = useArchivedSessions(snapshot => snapshot)

  useEffect(() => {
    void load()
  }, [load])

  const deleting = state.pendingDelete
  const deletingSize = deleting === null ? undefined : formatSize(deleting.sizeBytes)

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>

      {state.status === 'loading' && (
        <p className={css.status} aria-live="polite">{t('loading')}</p>
      )}

      {state.status === 'error' && (
        <div className={css.status}>
          <p className={css.error} role="alert">{t('loadFailed', { error: state.error ?? '' })}</p>
          <button type="button" className={css.retry} onClick={() => { void load() }}>
            {t('cancel')}
          </button>
        </div>
      )}

      {state.status === 'ready' && state.rows.length === 0 && (
        <p className={css.status}>{t('empty')}</p>
      )}

      {state.status === 'ready' && state.rows.length > 0 && (
        <ul className={css.rows}>
          {state.rows.map(row => {
            const busy = state.unarchiving.has(row.id)
            const size = formatSize(row.sizeBytes)
            return (
              <li key={row.id} className={css.row}>
                <div className={css.rowMain}>
                  <span className={css.rowTitle}>{row.displayTitle}</span>
                  <span className={css.rowMeta}>
                    {row.cwd !== undefined && row.cwd.length > 0 ? row.cwd : row.id}
                    {size !== undefined ? ` · ${size}` : ''}
                  </span>
                  <span className={css.rowMeta}>
                    {t('updated', { time: formatTime(row.updatedAt ?? row.createdAt) })}
                  </span>
                </div>
                <div className={css.rowActions}>
                  <Tooltip label={t('unarchive')} side="top" delayMs={400}>
                    <button
                      type="button"
                      className={css.action}
                      aria-label={t('unarchive')}
                      disabled={busy}
                      onClick={() => { void props.unarchive(row.id) }}
                    >
                      <IconRefreshOutline16 size={16} />
                      <span className={css.actionLabel}>
                        {busy ? t('unarchiving') : t('unarchive')}
                      </span>
                    </button>
                  </Tooltip>
                  <Tooltip label={t('delete')} side="top" delayMs={400}>
                    <button
                      type="button"
                      className={css.actionDanger}
                      aria-label={t('delete')}
                      disabled={busy}
                      onClick={() => { props.confirmDelete(row) }}
                    >
                      <IconTrashOutline16 size={16} />
                      <span className={css.actionLabel}>{t('delete')}</span>
                    </button>
                  </Tooltip>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        open={deleting !== null}
        onClose={() => { props.confirmDelete(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={deleting === null
          ? t('deleteDescription', { title: '', size: '' })
          : t('deleteDescription', {
            title: deleting.displayTitle,
            size: deletingSize === undefined ? '' : t('sizeBytes', { size: deletingSize }),
          })}
        className={css.deleteDialog as string}
        footer={(
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={state.deleting}
              onClick={() => { props.confirmDelete(null) }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.deleteConfirm}
              disabled={state.deleting}
              onClick={() => { void props.remove() }}
            >
              {state.deleting ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      >
        {state.deleteError === null
          ? null
          : <p className={css.error} role="alert">{t('actionFailed', { error: state.deleteError })}</p>}
      </Modal>
    </div>
  )
}
