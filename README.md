# dsh-archived-sessions

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web plugin that adds an **Archived Sessions** section to the Settings page for managing archived conversations.

> **Official source:** this repository is the official source of the npm package `dsh-archived-sessions` — `dsh plugin add dsh-archived-sessions` installs exactly this code.

![Archived Sessions in Settings](assets/screenshot.png)

## Features

- **List archived sessions** — each row shows the session's own name (the same title the sidebar uses), working directory, log size, and last update time.
- **Unarchive** — restore a session to the sidebar with one click; its original position in the workspace is kept.
- **Permanently delete** — removes the session's local log directory (`~/.dsh/sessions/...`) plus the attachment objects its log references that no other remaining session still uses, then drops the session from workspace accounting. A confirmation dialog must be acknowledged first.
- **Native look & feel** — built on the same UI primitives and design tokens as the built-in Settings sections.

## Requirements

- DeepSeek Harness **0.2.0-rc.2 or newer** — the plugin consumes the `@deepseek-ai/dsh-client-store` snapshot store and the `remote.session` / `workspaces` client services, which replaced the former `dsh-client-runtime` / `connection.api` surfaces.
- A core with the workspace **archive** surface (`workspaceRegistry.archivedSessionIds` / `unarchiveSession`).
- Deletion needs **no extra core support**. It clears the archive set through the existing `unarchiveSession`, whose contract is exactly what a delete needs: it drops the id from `archivedSessionIds`, touches no accounting slot, runs no session-existence check, and no-ops on an id that is not archived. Workspace `sessionIds` need no write either — that getter is already filtered by the canonical-cwd header index, so removing the log drops the session from the workspace projection by itself.
- A core older than the archive surface still degrades gracefully instead of failing: listing works, and the missing capability is reported as a structured `partial` result rather than thrown.

## Installation

Install from npm:

```sh
dsh plugin add dsh-archived-sessions
```

The plugin is then mounted automatically (its `dsh.bundle` patch joins the profile's bundle stack). Refresh the page (hard refresh) to load the client half, then open **Settings → Archived Sessions**.

Alternatively, install from source:

```sh
git clone https://github.com/Jxy-hy/dsh-archived-sessions.git
cd dsh-archived-sessions
pnpm install
pnpm run build
dsh plugin --profile web add link:./dsh-archived-sessions
```

Then mount it by appending to `~/.dsh/profiles/web/cordis.patch.yml` (or via your preferred bundle mechanism):

```yaml
- insert:
    - id: dsh-archived-sessions
      name: 'dsh-archived-sessions'
```

The host half hot-mounts through the profile's config HMR; refresh the page (hard refresh) to load the client half. Open **Settings → Archived Sessions**.

## Usage

1. Archive a session from the sidebar session menu (it hides from the sidebar).
2. Open **Settings → Archived Sessions**:
   - **Unarchive** — restores the session to its original sidebar position.
   - **Delete** — opens a confirmation dialog; confirming permanently deletes the local log and related attachments (objects still referenced by other sessions are kept) and removes the session from workspace accounting.

## Architecture

- **Host half** (`src/index.ts`) — registers `GET/POST /__dsh-archived-sessions/{list,unarchive,delete}` on the shared web server. The delete flow: dispose the live session first if it is open (so the in-memory store drops it and persistence retires its state) → wait for the write-behind flush to materialize the log → remove the session log directory → parse attachment references (`sha256:`) from the log → delete only the objects no other remaining session references → clear the archive set via `workspaceRegistry.unarchiveSession`.
- **Client half** (`src/client/`) — registers the `settings.section` entry "Archived Sessions"; the list merges the `remote.session` listing (including the projection title) with the plugin's host surface (creation time, log size); both mutations go through the host surface because the core RPC map offers neither operation. After a successful delete the client re-pulls the session-list baseline: deleting a cold (persisted, not-open) session emits no `session/disposed`, so the sidebar would otherwise keep the stale row under **Ungrouped** until the next reconnect.

## Verification

There is no test runner in this repo; both checks are standalone Node scripts over the **built** artifacts, so run `pnpm run build` first.

```sh
pnpm run verify
```

- `verify:delete` — points `DSH_HOME` at a throwaway tree and drives `lib/index.js` over a real HTTP socket: list reports rows with log facts; delete removes the log directory, GCs only the attachment objects no surviving session references (a shared object must survive), clears the archive set, and reports a complete result; a core lacking `unarchiveSession` degrades to `partial` instead of throwing.
- `verify:client` — executes `lib/client.js` against stubs for the shell's frozen module table, then mounts and renders the section. This catches the failure mode that once shipped a blank settings page: a named import the shell does not export (e.g. the removed `IconTrashOutline16`) resolves to `undefined` and only throws at **render** time, inside the slot's error boundary, so the page renders empty instead of failing loudly. Every name the bundle imports must be a real export of the shell's primitives.

## Community & Support

- Welcome to submit feedback or bug reports via [GitHub Discussions](https://github.com/Jxy-hy/dsh-archived-sessions/discussions).
- This repository carries the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic so it can be discovered.

## License

[MIT](LICENSE)
