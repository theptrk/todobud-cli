# TodoBud CLI

The official command-line interface for [TodoBud](https://todobud.com).

## Install

Requires Node.js 22.12 or newer:

```sh
npm install -g todobud
```

## Log in

For an interactive computer, use browser authorization:

```sh
todobud auth login
```

The CLI opens TodoBud, receives a one-time PKCE authorization code on a
random loopback port, and stores the resulting credentials in the operating
system keychain. It never asks for your TodoBud password.

For SSH and headless environments:

```sh
todobud auth login --device --no-browser
```

For CI and agents, create a managed key under **Profile → API Keys**:

```sh
export TODOBUD_API_KEY="tdb_..."
```

Use `TODOBUD_BASE_URL` only when connecting to another TodoBud deployment.

Browser sessions use 15-minute access tokens, sign out after 30 days without
use, and always require authorization again after 90 days. Revoke this device
with `todobud auth logout`, or revoke one or every device under **Profile →
Authorized CLIs**.

## Commands

Every resource supports `list`, `get`, and `create`. Todos, projects, and notes
also support `update` and `delete`; activities are list/create only because
that is what the API permits.

```sh
todobud todos list --filter status=T --all
todobud todos get 64
todobud todos create "Ship it" --description "Why this matters" --due-date 1/3/2026 --priority P1 --project 5
todobud todos update 64 --status D
todobud todos delete 64 --yes

todobud projects list
todobud notes create "Plan" --body "# Plan" --todo 64
todobud activities create --todo 64 --kind comment --message "Done"
```

`--data '{"title":"Ship it"}'` still works for scripts.

Add `--json` before the resource name for stable machine-readable output.
API filters can be repeated with `--filter key=value`.

## Updates

The CLI checks npm for a newer release at most once per day in interactive
terminals. It does not update itself or modify package-manager state:

```sh
todobud update
npm install -g todobud@latest
```

Set `TODOBUD_DISABLE_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1` to disable
automatic checks. Checks are disabled automatically in CI.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

This repository is source-visible but proprietary. See [LICENSE](LICENSE).

### Workspaces

Deploy the workspace-tenancy server before installing this CLI release.

```sh
todobud workspace list
todobud todos create "Personal task"
todobud --workspace acme todos create "Ship it"
todobud workspace use acme --here
todobud todos update 12 --status D
```

No workspace setup is needed for personal use. Reads and writes select scope
using `--workspace <id-or-slug|personal>`, then `TODOBUD_WORKSPACE`, then
`.todobud.json` in the exact current directory, then personal. The CLI never
searches parent directories, automatically loads `.env`, or applies global
workspace defaults. You can export `TODOBUD_WORKSPACE` using your shell or direnv.

The CLI resolves the selection with a read, then sends the resolved integer ID
in `X-Workspace` on the write. The server also defaults omitted identifiers to
personal. Explicit invalid or inaccessible selections fail without falling back.
`personal` is a CLI convenience, not a team slug or URL. While team access is
disabled on the server, team selections return 404 even for members.

Each successful write (including deletes) prints `Workspace: acme (#12)` to
stderr, using the server's response headers. `--json` stdout remains valid JSON.
If a response lacks confirmation, the CLI says the write succeeded without
confirmation and asks you to verify before retrying.

`workspace use <id-or-slug|personal> --here` saves `.todobud.json` in the current
directory only. It contains no credentials:

```json
{ "server": "https://todobud.com", "workspace": 12 }
```

Team selections are stored by ID so renaming a slug does not retarget requests.
Personal is stored as `"personal"` and resolves against the current account.
The configured server must match `TODOBUD_BASE_URL` (default `https://todobud.com`).
Subdirectories do not inherit the file; they default to personal unless an
environment export, explicit flag, or their own file selects a workspace.
Malformed configuration and unavailable selections produce errors. Flags and
exports can override the file for a command. Correct malformed or mismatched
files before replacing them with `workspace use ... --here`.
