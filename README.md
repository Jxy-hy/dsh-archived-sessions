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

- DeepSeek Harness with the workspace **archive** feature (the `archivedSessionIds`/`archiveSession` surface).
- Full unarchive/delete functionality requires the core `WorkspaceRegistry.unarchiveSession` / `deleteSession` methods. Until they ship in a released core, the plugin degrades gracefully: it still lists archived sessions and can still remove on-disk files, while unarchive reports a clear "restart `dsh web`" hint.

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

- **Host half** (`src/index.ts`) — registers `GET/POST /__dsh-archived-sessions/{list,unarchive,delete}` on the shared web server. The delete flow: remove the session log directory → parse attachment references (`sha256:`) from the log → delete only the objects no other remaining session references → drop workspace accounting via `WorkspaceRegistry.deleteSession`.
- **Client half** (`src/client/`) — registers the `settings.section` entry "Archived Sessions"; the list merges `session.list` (including the projection title) with the plugin's host surface (creation time, log size); both mutations go through the host surface because the core RPC map offers neither operation.

## Community & Support

- Welcome to submit feedback or bug reports via [GitHub Discussions](https://github.com/Jxy-hy/dsh-archived-sessions/discussions).
- This repository carries the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic so it can be discovered.

## License

[MIT](LICENSE)
