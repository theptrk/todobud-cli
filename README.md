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
todobud todos create "Ship it" --priority P1 --project 5
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
