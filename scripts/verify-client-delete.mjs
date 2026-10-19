/**
 * Exercises the client half's delete convergence against the BUILT bundle.
 *
 * The sidebar row is removed by re-pulling the session list, and that pull is
 * single-flight: a call made while another pull is in flight resolves with THAT
 * pull, whose payload predates the delete. A single refresh therefore brings the
 * deleted row back. This script drives `remove()` through three interleavings
 * and asserts how many pulls it takes and what the page reports:
 *
 *   A. the row is gone straight after the event        -> one pull, no warning
 *   B. the first pull is stale, the second is not      -> two pulls, no warning
 *   C. the pull never converges                        -> bounded pulls, warning
 *
 * Run: node scripts/verify-client-delete.mjs  (needs `pnpm run build` first)
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'lib', 'client.js')
const pluginRequire = createRequire(join(here, '..', 'package.json'))

const React = pluginRequire('react')
const jsxRuntime = pluginRequire('react/jsx-runtime')

const primitives = {
  Button: ({ children }) => React.createElement('button', null, children),
  Modal: () => null,
  Tooltip: ({ children }) => React.createElement('span', null, children),
  IconTrashOutlineRegular: () => React.createElement('svg'),
  IconUnarchiveOutlineRegular: () => React.createElement('svg'),
}
function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    set: (next) => { snapshot = next; for (const l of listeners) l() },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
    use: (selector) => selector(snapshot),
  }
}

const VICTIM = 'session-victim-abcdef01'

/** Load one fresh instance of the bundle (each scenario needs its own state). */
function loadBundle() {
  let registration
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  new Function('window', readFileSync(BUNDLE, 'utf8'))(globalThis.window)
  return registration
}

/**
 * Run one interleaving.
 * @param removeOnPull - the pull number (1-based) after which the row is gone,
 *   or Infinity to model a pull that never converges.
 */
async function scenario(removeOnPull) {
  const registration = loadBundle()
  const required = []
  const exportsObj = registration.factory((name) => {
    required.push(name)
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected module ${name}`)
  })

  const listed = new Set([VICTIM])
  let pulls = 0
  const sessions = {
    // The exact surface the sidebar renders from.
    list: { getSnapshot: () => ({ byId: Object.fromEntries([...listed].map(id => [id, { id }])) }) },
    refresh: async () => {
      pulls += 1
      if (pulls >= removeOnPull) listed.delete(VICTIM)
    },
  }

  const slots = {
    inject: (_slot, fn) => fn(),
    register: (options) => { slots.options = options; return () => {} },
  }
  let registered
  slots.register = (options, component) => { registered = { options, component }; return () => {} }
  const ctx = {
    slots,
    get: (name) => {
      if (name === 'sessions') return sessions
      if (name === 'remote') return { session: { list: async () => ({ ok: true, value: { items: [] } }) } }
      if (name === 'workspaces') return { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } }
      return {}
    },
  }

  // The host surface: /delete succeeds, /list is empty.
  const requests = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (path) => {
    requests.push(String(path))
    if (String(path).includes('/delete')) {
      return { json: async () => ({ ok: true, stillListed: false }) }
    }
    return { json: async () => ({ ok: true, rows: [] }) }
  }

  try {
    exportsObj.apply(ctx)
    const face = registered.options.inject({})
    face.confirmDelete({ id: VICTIM, displayTitle: 'victim' })
    await face.remove()
    const state = face.hooks.archivedSessions.getSnapshot()
    return {
      pulls,
      deleteStillListed: state.deleteStillListed,
      deleteError: state.deleteError,
      stillListed: listed.has(VICTIM),
      requestedDelete: requests.some(r => r.includes('/delete')),
    }
  } finally {
    globalThis.fetch = realFetch
  }
}

const results = []
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) console.log(`        actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

// --- A: the row is already gone, so a single pull finishes the job ----------
{
  const r = await scenario(1)
  check('A1 delete reached the host surface', r.requestedDelete, true)
  check('A2 one pull was enough', r.pulls, 1)
  check('A3 the row is gone', r.stillListed, false)
  check('A4 no ghost warning', r.deleteStillListed, false)
  check('A5 no delete error', r.deleteError, null)
}

// --- B: the first pull is a stale in-flight partner (the reported race) -----
{
  const r = await scenario(2)
  check('B1 a stale first pull is retried', r.pulls >= 2, true)
  check('B2 the retry converges', r.stillListed, false)
  check('B3 no ghost warning after convergence', r.deleteStillListed, false)
}

// --- C: the pull never converges, so the page must say so -------------------
{
  const r = await scenario(Number.POSITIVE_INFINITY)
  check('C1 pulls are bounded, not unbounded', r.pulls >= 2 && r.pulls <= 5, true)
  check('C2 the ghost is reported', r.deleteStillListed, true)
  check('C3 the row is still there, matching the warning', r.stillListed, true)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.label}`)
  process.exitCode = 1
}
