---
"todobud": minor
---

Default to personal without setup, with workspace selection from `--workspace`, `TODOBUD_WORKSPACE`, or `.todobud.json` in the exact current directory. Resolve and pin workspace IDs before writes and print server-confirmed receipts. Add `workspace list` and `workspace use ... --here`, storing team IDs and an account-relative personal default. Never inherit ancestor or global workspace settings. Requires the workspace-tenancy server release first.
