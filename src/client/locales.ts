/**
 * `settings.archivedSessions` dictionary: the archived-sessions Settings
 * section page (the zh set is the key source of truth).
 */

/** Simplified Chinese dictionary (key-set source of truth). */
export const zh = {
  'nav': '归档会话',
  'title': '归档会话',
  'intro': '已归档的会话会从侧边栏隐藏。可以在此取消归档以恢复使用，或彻底删除（连同本地日志与关联附件，无法恢复）。',
  'loading': '正在加载…',
  'empty': '暂无归档会话',
  'loadFailed': '加载失败：{error}',
  'updated': '更新于 {time}',
  'created': '创建于 {time}',
  'unarchive': '取消归档',
  'unarchiving': '正在恢复…',
  'actionFailed': '操作失败：{error}',
  'delete': '删除',
  'deleteTitle': '删除归档会话',
  'deleteDescription': '将永久删除会话“{title}”的本地日志{size}及其关联附件，此操作无法恢复。',
  'deleteConfirm': '确认删除',
  'deleting': '正在删除…',
  'cancel': '取消',
  'close': '关闭',
  'sizeBytes': '（{size}）',
  'unknownTime': '时间未知',
} satisfies Record<string, string>

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'nav': 'Archived Sessions',
  'title': 'Archived Sessions',
  'intro': 'Archived sessions are hidden from the sidebar. Unarchive one to restore it, or delete it permanently (local log and related attachments, not recoverable).',
  'loading': 'Loading…',
  'empty': 'No archived sessions',
  'loadFailed': 'Failed to load: {error}',
  'updated': 'Updated {time}',
  'created': 'Created {time}',
  'unarchive': 'Unarchive',
  'unarchiving': 'Restoring…',
  'actionFailed': 'Action failed: {error}',
  'delete': 'Delete',
  'deleteTitle': 'Delete archived session',
  'deleteDescription': 'This permanently deletes the local log{size} and related attachments for session “{title}”. This cannot be undone.',
  'deleteConfirm': 'Delete',
  'deleting': 'Deleting…',
  'cancel': 'Cancel',
  'close': 'Close',
  'sizeBytes': ' ({size})',
  'unknownTime': 'Unknown time',
} satisfies Record<string, string>

export type ArchivedSessionsKey = keyof typeof zh

/**
 * Whether the active UI language is Chinese. The plugin carries its own
 * tiny resolver instead of the locale service: the built locale types only
 * know the namespaces registered at compile time, so a plugin namespace
 * would fight the constraint system for no benefit.
 */
export function isZh(): boolean {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
}

/** Resolve one key in the active dictionary, with `{name}` interpolation. */
export function t(key: ArchivedSessionsKey, params?: Record<string, unknown>): string {
  const dict = isZh() ? zh : en
  let template = dict[key] ?? key
  if (params !== undefined) {
    template = template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
  return template
}
