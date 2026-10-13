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
random loopback port, and stores the resulting credentials using the selected
credential backend. It never asks for your TodoBud password.

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

### Credential storage and recovery

Storage is selected per server and persists across separate CLI processes:

```sh
todobud auth status
todobud auth login --storage file
todobud auth storage file
todobud auth storage keyring
todobud auth storage auto
```

`auth storage` migrates an accessible existing session without browser login or
copying tokens. `auth login --storage` creates a new session and saves the mode
only when that login is saved. Cancelling or failing authorization keeps the
previous session. A successful replacement login saves the new session before
revoking the previous one. If the old store cannot be read, revoke older devices
from **Profile → Authorized CLIs**.

| Mode             | Behavior                                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Uses the OS credential store for a new session and verifies the write. If the write fails (including a duplicate-item error) or cannot be read back, saves to a restricted file and reports the fallback on stderr. An existing file-backed session stays on file storage, including after Keychain access returns. |
| `keyring`        | Requires the OS credential store; never falls back to file credentials. Local metadata and locks contain no tokens. A failed refresh save may require a new browser login.                                                                                                                                          |
| `file`           | Reads and writes credentials in a restricted local file. Attempts to remove an old Keychain copy after migration/login and logout; inability to remove it does not change which session is active.                                                                                                                  |

`TODOBUD_CREDENTIAL_STORE=auto|keyring|file` overrides the saved mode. A conflicting
override fails rather than selecting an older credential copy or silently
migrating on a read; unset it before using `auth storage` to change the saved
mode. `TODOBUD_API_KEY` retains precedence for API requests and `auth status`.

On Unix, credentials live under `~/.todobud/credentials/` in directories with
mode `0700` and files with mode `0600`. On Windows the same directory is under
`%USERPROFILE%`; the CLI enforces an owner-only DACL with Windows PowerShell
before writing secrets. Credentials are keyed by the SHA-256 of the normalized
server origin, independently of the working directory and workspace config.
Files are unencrypted: treat them as passwords. No credential-directory override
is accepted from a repository. Owned existing files have their permissions
restricted; symlinks, hard links, foreign owners, malformed records, and
inaccessible stores fail explicitly rather than selecting stale credentials.

The per-server record is authoritative: file credentials always win over stale
Keychain copies, and a logout marker prevents an inaccessible old copy from
reappearing later. `auth status` reports the selected mode, active backend, file
location when relevant, expiry/recovery state, and pending stale-copy cleanup,
without showing tokens. Retry `auth storage` or `auth logout` from a terminal
with Keychain access to finish pending cleanup.

All session updates, migration, logout, and refresh use the same per-server OS
file lock. The CLI re-reads credentials after acquiring it; concurrent commands
reuse the winner's refreshed tokens. A 401 retry identifies the token that was
rejected so it does not rotate a newer session again. Locks release on process
exit or crash, and do not expire while a process is still running. If a command
waits more than a minute, it reports a coordination error and leaves the session
alone. Upgrade all CLI processes before relying on this coordination.

File writes use exclusive temporary files, fsync, and atomic replacement. A
fully written recovery record takes precedence if the final commit fails.
If an earlier rename fails, the restricted temporary copy remains available:

```sh
todobud auth recover
```

Restore directory access first. Recovery is server-specific, validates the file,
and refuses to overwrite a newer active session. If the directory cannot accept
any write, or strict `keyring` storage cannot save a rotated token, the CLI
retains the old copy and reports that the server refreshed it but persistence
failed; it records this diagnostic when possible. A new browser login is the
recovery path when no usable recovery copy exists. It never prints or asks you
to copy the tokens. An `invalid_grant` response records an expired/revoked
session without deleting its credentials, so status and logout remain useful.

An unavailable store is not proof of an expired session. Agent sandboxes and
SSH sessions can deny Keychain access or conceal an existing entry. Compare
`auth status` in a normal terminal and the restricted environment. From a
terminal that can read the existing session, `auth storage file` supplies a
supported way to migrate it. The restricted environment still needs filesystem
access to `~/.todobud` and network access to TodoBud.

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

### Release deployment

Merging application changes does not publish an npm version. The release workflow
uses Changesets CLI v3 with Changesets action v2: it opens a version PR, then
publishes after that PR is merged. Deploy required server changes first.

Repository setup requires GitHub Actions to be allowed to create pull requests.
On npm, configure the `todobud` package's GitHub trusted publisher with user
`theptrk`, repository `todobud-cli`, workflow `release.yml`, and environment `npm`,
allowing direct `npm publish`. After setup, set the repository variable
`NPM_TRUSTED_PUBLISHING_READY=true`. Publishing uses GitHub OIDC without an npm token.
The release workflow fails explicitly if a version is ready but this gate is unset.

Verify delivery using the public registry and the installed CLI:

```sh
npm view todobud dist-tags.latest
todobud --version
todobud update
```

The registry's latest version must advance before the installed CLI can announce
an update. A passing build or merged PR alone does not establish deployment.

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
Resolution accepts read or write scope; write-only keys do not need content read
permission. Invalid or mismatched resolution stops the write and config save.
`personal` is a CLI convenience, not a team slug or URL. While team access is
disabled on the server, team selections return 404 even for members.

Each successful write (including deletes) prints `Workspace: acme (#12)` to
stderr, using the server's response headers. `--json` stdout remains valid JSON.
JSON deletes return `{ "deleted": true, "id": "12" }`.
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
