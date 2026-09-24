---
"todobud": patch
---

Fix `activities list --all` failing with "page.results is not iterable" on endpoints that return a bare array instead of a paginated envelope, and stop advertising `--page`/`--page-size` on the unpaginated activities list.
