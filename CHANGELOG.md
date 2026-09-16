# todobud

## 0.2.1

### Patch Changes

- bc1054d: `todobud update` waits up to 10 seconds for npm instead of 1, no longer prints the update notice twice, and a failed check keeps the last known release so the automatic notice still appears.

## 0.2.0

### Minor Changes

- 05e3b1b: Default to personal without setup, with workspace selection from `--workspace`, `TODOBUD_WORKSPACE`, or `.todobud.json` in the exact current directory. Resolve and pin workspace IDs before writes and print server-confirmed receipts. Add `workspace list` and `workspace use ... --here`, storing team IDs and an account-relative personal default. Never inherit ancestor or global workspace settings. Requires the workspace-tenancy server release first.

### Patch Changes

- 865e86f: Initial public TodoBud CLI with browser and device login, API commands, and update checks.
