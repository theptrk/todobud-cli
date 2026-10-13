# Credential storage verification — todo 279

## Diagnosis on macOS

The installed CLI reports `Not logged in` inside the agent workspace sandbox but
finds the existing browser session outside it. Direct `@napi-rs/keyring` reads
of the same entry report absent inside and present outside, without printing
credentials. A write to an isolated diagnostic entry inside the sandbox fails
with `Platform failure: Unable to obtain authorization for this operation`.
Outside the sandbox, creating, updating twice, reading back, and deleting that
diagnostic entry all succeed.

This establishes sandbox contribution to the inconsistent login status. It does
not confirm the cause of the earlier duplicate-item error: that particular native
error was not reproduced in the unrestricted diagnostic. The product fix handles
duplicate-item write failure without claiming it caused every observed failure.

## Local validation

The existing 45 tests pass with Node 24.14.1 outside the sandbox. The sandbox
denies loopback listen/connect needed by the existing browser/API tests.
No additional repository tests were added, as requested in the task.

A temporary smoke harness outside the repository uses isolated `/tmp` stores,
a loopback OAuth/API fixture, and separate CLI processes. It verifies:

- Unix directory/file modes are `0700`/`0600`; a later process reads saved credentials.
- Sixteen simultaneous expired-token requests rotate the shared refresh token once, with no `invalid_grant`; absent refresh scope retains the old scope.
- Sixteen simultaneous 401 requests share one rotation and reuse the replacement token.
- Denied final commit retains the new credentials in the authoritative recovery record; denied staging rename retains a restricted temporary copy; `auth recover` restores both without another rotation.
- `invalid_grant` retains the rejected credentials, records expiry, and prevents repeated refresh attempts.
- Logout revokes before removing token material; a logged-out record prevents stale Keychain resurrection.
- Injected duplicate-item and cleanup failures lead to sticky file fallback; strict keyring selection refuses file credentials.
- Migration works both directions, removes the old copy, stores no file tokens after keyring migration, and isolates servers.
- Symlinked credential paths are rejected; a killed lock holder releases the lock automatically.

The CI matrix runs the existing suite, formatting, type checks, and packaging on
Linux, macOS, and Windows with Node 22.12 and 24. Windows owner-only ACL enforcement
is exercised by the existing auth tests' metadata writes; Unix permissions are
also inspected in the local smoke harness.

References used for the design:

- [Codex credential modes](https://learn.chatgpt.com/docs/auth#credential-storage).
- [Claude Code Keychain fallback](https://code.claude.com/docs/en/authentication#credential-management).
- [Native OS locking API](https://github.com/holepunchto/fs-native-extensions).
- [Windows directory ACLs](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.directorysecurity).
