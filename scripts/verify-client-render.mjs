/**
 * Executes the BUILT browser bundle (lib/client.js) in Node against stubs for
 * the shell's frozen module table, then mounts and renders the registered
 * section. This is the check that catches the class of bug that made the
 * settings page blank: a named import resolving to `undefined` in the shell's
 * primitives (e.g. the removed `IconTrashOutline16`) only throws at RENDER
 * time, inside the slot's error boundary, so the page renders empty instead of
 * failing loudly.
 *
 * Run: node scripts/verify-client-render.mjs
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'lib', 'client.js')
const pluginRequire = createRequire(join(here, '..', 'package.json'))

// --- React (the plugin's own copy is the shell's version: 18.2) ------------
const React = pluginRequire('react')
const jsxRuntime = pluginRequire('react/jsx-runtime')
const { renderToStaticMarkup } = pluginRequire('react-dom/server')

// --- Minimal stand-ins for the shell's frozen table ------------------------
const rendered = { icons: [] }

/** Every icon name the shell's primitives must actually export. */
const PRIMITIVE_EXPORTS = [
  'Button', 'Modal', 'Tooltip',
  'IconTrashOutlineRegular', 'IconUnarchiveOutlineRegular',
]

function stubIcon(name) {
  return function Icon(props) {
    rendered.icons.push({ name, size: props?.size })
    return React.createElement('svg', { 'data-icon': name, width: props?.size, height: props?.size })
  }
}

const primitives = {
  Button: ({ children, ...rest }) => React.createElement('button', rest, children),
  Modal: ({ open, children, footer }) => (open
    ? React.createElement('div', { 'data-modal': 'open' }, children, footer)
    : null),
  Tooltip: ({ children }) => React.createElement('span', null, children),
  IconTrashOutlineRegular: stubIcon('IconTrashOutlineRegular'),
  IconUnarchiveOutlineRegular: stubIcon('IconUnarchiveOutlineRegular'),
}

// A snapshot store with the `.use(selector)` face the slot renderer binds.
function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    set: (next) => { snapshot = next; for (const l of listeners) l() },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
    use: (selector) => React.useSyncExternalStore(
      (l) => { listeners.add(l); return () => listeners.delete(l) },
      () => selector(snapshot),
    ),
  }
}

const clientStore = { createSnapshotStore }

// --- Load the bundle through the loader shim it expects -------------------
let registration
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => { registration = entry },
  },
}

const source = readFileSync(BUNDLE, 'utf8')
// eslint-disable-next-line no-new-func -- the bundle is a trusted local build
new Function('window', source)(globalThis.window)

const results = []
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`        actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
function checkThat(label, condition, detail = '') {
  results.push({ label, pass: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  ${detail}`}`)
}

check('1 bundle registers under its id', registration?.id, 'dsh-archived-sessions')
checkThat('2 bundle exposes a factory', typeof registration?.factory === 'function')

const stubFor = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return jsxRuntime
  if (name === '@deepseek-ai/dsh-client-store') return clientStore
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`bundle required an unexpected module: ${name}`)
}
const requires = []
const exportsObj = registration.factory((name) => { requires.push(name); return stubFor(name) })

check('3 every required module is one the shell freezes',
  [...new Set(requires)].sort(),
  ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime'])
checkThat('4 the module exports apply/inject', typeof exportsObj.apply === 'function' && Array.isArray(exportsObj.inject))

// --- Mount against a fake client ctx --------------------------------------
let registered
const state = {
  status: 'ready',
  error: null,
  rows: [{
    id: 'session-abc12345-6789-abcd-ef01-234567890abc',
    displayTitle: 'A sandbox row',
    cwd: 'E:\\PROJECT\\Demo',
    updatedAt: 1787122105952,
    sizeBytes: 2023489,
  }],
  unarchiving: new Set(),
  pendingDelete: null,
  deleting: false,
  deleteError: null,
}
const hooks = createSnapshotStore(state)
const loadCalls = []
const ctx = {
  slots: {
    inject: (_slot, fn) => fn(),
    register: (options, component) => { registered = { options, component }; return () => {} },
  },
  get: () => ({}),
}
const ctxStubFor = (name) => {
  if (name === 'sessions') return { refresh: async () => {} }
  if (name === 'remote') return { session: { list: async () => ({ ok: true, value: { items: [] } }) } }
  if (name === 'workspaces') return { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } }
  return {}
}
ctx.get = ctxStubFor

// The controller builds its own store; swap in ours so we render known rows.
const originalApply = exportsObj.apply
// apply() constructs the controller internally, so drive it and then override
// the injected face's hooks with our own store before rendering.
originalApply(ctx)
checkThat('5 apply registered a settings.section entry', registered?.options?.name === 'settings.section')
check('6 the section id is stable', registered?.options?.id, 'archived-sessions')
checkThat('7 the registration carries a business face', typeof registered?.options?.inject === 'function')

const face = registered.options.inject({})
checkThat('8 the injected face exposes the snapshot store', typeof face.hooks?.archivedSessions?.getSnapshot === 'function')
// Replace the controller's store with a populated one so the row branch renders.
face.hooks.archivedSessions = hooks
face.load = async () => { loadCalls.push(1) }

const props = { ...face, useArchivedSessions: (selector) => selector(hooks.getSnapshot()) }
let markup
try {
  markup = renderToStaticMarkup(React.createElement(registered.component, props))
  checkThat('9 the section renders without throwing', markup.length > 0)
} catch (error) {
  checkThat('9 the section renders without throwing', false, `-> ${String(error)}`)
}

if (markup !== undefined) {
  checkThat('10 the row title is rendered', markup.includes('A sandbox row'))
  checkThat('11 the workspace path is rendered', markup.includes('Demo'))
  checkThat('12 the size is formatted', markup.includes('1.9 MB'))
  checkThat('13 the unarchive icon rendered from the shell export',
    markup.includes('IconUnarchiveOutlineRegular'))
  checkThat('14 the delete icon rendered from the shell export',
    markup.includes('IconTrashOutlineRegular'))
  const sizes = rendered.icons.map(i => i.size)
  checkThat('15 the icons were passed an explicit size', sizes.length > 0 && sizes.every(s => s === 16), `sizes=${JSON.stringify(sizes)}`)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.label}`)
  process.exitCode = 1
}
