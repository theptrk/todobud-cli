import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  atomicPrivateWrite,
  CredentialStoreError,
  ensureDirectory,
  isMissing,
  promotePrivateFile,
  readPrivateFile,
  removePrivateFile,
  securePath,
} from "./credential-files.js";

export { CredentialStoreError } from "./credential-files.js";
export type CredentialStore = "auto" | "keyring" | "file";
export interface CredentialBackend {
  get(baseUrl: string): string | null;
  set(baseUrl: string, value: string): void;
  delete(baseUrl: string): void;
}
export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  scope: string;
}
interface CredentialRecord {
  version: 1;
  baseUrl: string;
  mode: CredentialStore;
  backend: "keyring" | "file" | "none";
  updatedAt: string;
  credentials?: StoredCredentials;
  problem?: "expired" | "refresh-save-failed";
  cleanupPending?: boolean;
}

const require = createRequire(import.meta.url);
function entry(baseUrl: string): import("@napi-rs/keyring").Entry {
  const { Entry } =
    require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return new Entry("todobud-cli", baseUrl);
}
let backend: CredentialBackend = {
  get: (baseUrl) => {
    const secret = entry(baseUrl).getSecret();
    return secret === null ? null : Buffer.from(secret).toString("utf8");
  },
  set: (baseUrl, value) => entry(baseUrl).setPassword(value),
  delete: (baseUrl) => {
    entry(baseUrl).deleteCredential();
  },
};
let testDirectory: string | undefined;
export function setCredentialDirectoryForTesting(path: string): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Credential directories can only be replaced in tests.");
  testDirectory = path;
}
export function setCredentialBackendForTesting(value: CredentialBackend): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error("The credential backend can only be replaced in tests.");
  backend = value;
  testDirectory = mkdtempSync(join(tmpdir(), "todobud-auth-"));
}

function paths(baseUrl: string) {
  const root = testDirectory ?? join(homedir(), ".todobud");
  ensureDirectory(root);
  const directory = join(root, "credentials");
  ensureDirectory(directory);
  const id = createHash("sha256").update(baseUrl).digest("hex");
  const path = join(directory, `${id}.json`);
  return {
    directory,
    id,
    path,
    recovery: `${path}.recovery`,
    lock: `${path}.lock`,
  };
}

export function parseCredentialStore(value: string): CredentialStore {
  if (!["auto", "keyring", "file"].includes(value)) {
    throw new Error("Credential storage must be auto, keyring, or file.");
  }
  return value as CredentialStore;
}

function mode(record: CredentialRecord | null): CredentialStore {
  const override = process.env.TODOBUD_CREDENTIAL_STORE;
  return override === undefined
    ? (record?.mode ?? "auto")
    : parseCredentialStore(override);
}

function parseCredentials(serialized: string): StoredCredentials {
  let value: Partial<StoredCredentials>;
  try {
    value = JSON.parse(serialized) as Partial<StoredCredentials>;
  } catch {
    throw new CredentialStoreError(
      "Stored credentials are malformed. Run `todobud auth login --storage file` to replace them.",
    );
  }
  if (
    !value ||
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    typeof value.refreshToken !== "string" ||
    !value.refreshToken ||
    typeof value.accessExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.accessExpiresAt)) ||
    typeof value.scope !== "string"
  ) {
    throw new CredentialStoreError(
      "Stored credentials are malformed. Run `todobud auth login --storage file` to replace them.",
    );
  }
  return value as StoredCredentials;
}

function parseRecord(serialized: string, baseUrl: string): CredentialRecord {
  let record: CredentialRecord;
  try {
    record = JSON.parse(serialized) as CredentialRecord;
  } catch {
    throw new CredentialStoreError(
      "Credential metadata is malformed; no older credential copy will be selected. Run `todobud auth recover`.",
    );
  }
  if (
    !record ||
    record.version !== 1 ||
    record.baseUrl !== baseUrl ||
    !["auto", "keyring", "file"].includes(record.mode) ||
    !["keyring", "file", "none"].includes(record.backend) ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    (record.problem !== undefined &&
      !["expired", "refresh-save-failed"].includes(record.problem)) ||
    (record.backend !== "file" && record.credentials !== undefined)
  ) {
    throw new CredentialStoreError(
      "Credential metadata is invalid; no older credential copy will be selected. Run `todobud auth recover`.",
    );
  }
  if (record.backend === "file")
    parseCredentials(JSON.stringify(record.credentials));
  return record;
}

function readRecord(baseUrl: string): CredentialRecord | null {
  const p = paths(baseUrl);
  const serialized = readPrivateFile(p.recovery) ?? readPrivateFile(p.path);
  return serialized === null ? null : parseRecord(serialized, baseUrl);
}

function writeRecord(record: CredentialRecord): void {
  const p = paths(record.baseUrl);
  atomicPrivateWrite(p.recovery, JSON.stringify(record));
  try {
    promotePrivateFile(p.recovery, p.path);
  } catch {
    throw new CredentialStoreError(
      `Unable to commit credential metadata. The latest session is preserved in ${p.recovery} and will be selected by the next command. Restore directory access, then run \`todobud auth recover\`.`,
      true,
    );
  }
}

function removeRecoveryCopies(baseUrl: string): void {
  const p = paths(baseUrl);
  for (const name of readdirSync(p.directory)) {
    if (name.startsWith(`${p.id}.json.recovery.`) && name.endsWith(".tmp")) {
      try {
        removePrivateFile(join(p.directory, name));
      } catch {
        console.error(
          "A stale restricted recovery copy could not be removed. Retry `todobud auth storage` when directory access is restored.",
        );
      }
    }
  }
}

function keyringError(): CredentialStoreError {
  return new CredentialStoreError(
    "The operating-system credential store is unavailable or could not persist this session. " +
      "Check Keychain access in a normal terminal; an agent sandbox or SSH session may block it. " +
      "Use `todobud auth storage file` from a terminal that can read the session, or `todobud auth login --storage file` for a new file-backed login.",
  );
}

function readKeyring(baseUrl: string): StoredCredentials | null {
  let serialized: string | null;
  try {
    serialized = backend.get(baseUrl);
  } catch {
    throw keyringError();
  }
  return serialized === null ? null : parseCredentials(serialized);
}

function cleanupKeyring(baseUrl: string): boolean {
  try {
    backend.delete(baseUrl);
    return true;
  } catch {
    console.error(
      "Credential storage: stale Keychain copy could not be removed. It will not be selected; cleanup will be retried by `todobud auth storage` or `todobud auth logout` when Keychain access returns.",
    );
    return false;
  }
}

export function loadCredentials(baseUrl: string): StoredCredentials | null {
  const record = readRecord(baseUrl);
  if (record?.backend === "none") return null;
  const selected = mode(record);
  if (record?.backend === "file") {
    if (selected === "keyring")
      throw new CredentialStoreError(
        "The active session uses file storage. Run `todobud auth storage keyring` to migrate it; stale Keychain credentials will not be used.",
      );
    return record.credentials!;
  }
  if (selected === "file") {
    if (record?.backend === "keyring")
      throw new CredentialStoreError(
        "The active session uses Keychain. Run `todobud auth storage file` from a terminal with Keychain access to migrate it.",
      );
    return null;
  }
  const stored = readKeyring(baseUrl);
  if (!stored && record?.backend === "keyring") {
    throw new CredentialStoreError(
      "A Keychain session is recorded but is not accessible to this process. This is a credential-store problem, not proof of an expired session. Check access in a normal terminal or run `todobud auth login --storage file`.",
    );
  }
  return stored;
}

export function credentialInfo(baseUrl: string) {
  const record = readRecord(baseUrl);
  return {
    mode: mode(record),
    backend: record?.backend ?? "keyring",
    path: paths(baseUrl).path,
    problem: record?.problem,
    cleanupPending: record?.cleanupPending ?? false,
  };
}

export function saveCredentials(
  baseUrl: string,
  credentials: StoredCredentials,
  requested?: CredentialStore,
  replace = false,
): void {
  parseCredentials(JSON.stringify(credentials));
  let previous: CredentialRecord | null;
  try {
    previous = readRecord(baseUrl);
  } catch (error) {
    // A newly authorized login may replace malformed owned metadata. Unsafe
    // paths and filesystem/access errors must still stop the write.
    if (
      !replace ||
      !(error instanceof CredentialStoreError) ||
      !/malformed|invalid/.test(error.message)
    )
      throw error;
    previous = null;
  }
  const selected = requested ?? mode(previous);
  const record: CredentialRecord = {
    version: 1,
    baseUrl,
    mode: selected,
    backend: "file",
    updatedAt: new Date(
      Math.max(Date.now(), Date.parse(previous?.updatedAt ?? "") + 1 || 0),
    ).toISOString(),
  };
  // Auto keeps a file-backed session on file storage until explicitly migrated.
  if (
    selected === "keyring" ||
    (selected === "auto" && previous?.backend !== "file")
  ) {
    try {
      const serialized = JSON.stringify(credentials);
      backend.set(baseUrl, serialized);
      if (backend.get(baseUrl) !== serialized) throw keyringError();
      record.backend = "keyring";
    } catch {
      if (selected === "keyring") throw keyringError();
      console.error(
        "Credential storage: Keychain write or verification failed; using the restricted credential file. This choice persists across commands.",
      );
    }
  }
  if (record.backend === "file") record.credentials = credentials;
  // Establish the authoritative copy before removing any older credentials.
  writeRecord(record);
  if (
    record.backend === "file" &&
    (previous?.backend !== "file" || previous.cleanupPending)
  ) {
    record.cleanupPending = !cleanupKeyring(baseUrl);
    if (record.cleanupPending) writeRecord(record);
  }
  removeRecoveryCopies(baseUrl);
}

export function markCredentialProblem(
  baseUrl: string,
  expected: StoredCredentials,
  problem: CredentialRecord["problem"],
): void {
  const current = loadCredentials(baseUrl);
  if (
    current?.refreshToken !== expected.refreshToken ||
    current.accessToken !== expected.accessToken
  )
    return;
  const record = readRecord(baseUrl) ?? {
    version: 1 as const,
    baseUrl,
    mode: mode(null),
    backend: "keyring" as const,
    updatedAt: new Date().toISOString(),
  };
  if (problem !== undefined) record.problem = problem;
  writeRecord(record);
}

export function deleteCredentials(baseUrl: string): void {
  const previous = readRecord(baseUrl);
  const record: CredentialRecord = {
    version: 1,
    baseUrl,
    mode: mode(previous),
    backend: "none",
    updatedAt: new Date(
      Math.max(Date.now(), Date.parse(previous?.updatedAt ?? "") + 1 || 0),
    ).toISOString(),
  };
  // A durable logout marker prevents inaccessible stale copies reappearing.
  writeRecord(record);
  record.cleanupPending = !cleanupKeyring(baseUrl);
  if (record.cleanupPending) writeRecord(record);
  removeRecoveryCopies(baseUrl);
}

export async function withCredentialLock<T>(
  baseUrl: string,
  action: () => Promise<T>,
): Promise<T> {
  let fd: number | undefined;
  try {
    const p = paths(baseUrl);
    try {
      securePath(p.lock);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    fd = openSync(
      p.lock,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    securePath(p.lock);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (process.platform !== "win32" && stat.uid !== process.getuid!())
    ) {
      throw new CredentialStoreError("Unsafe credential lock file.");
    }
    const { tryLock } = require("fs-native-extensions") as {
      tryLock(fd: number): boolean;
    };
    const deadline = Date.now() + 60_000;
    while (!tryLock(fd)) {
      if (Date.now() >= deadline)
        throw new CredentialStoreError(
          "Another TodoBud process is updating credentials. Retry after it finishes; no session was changed.",
        );
      await delay(50);
    }
    // Never unlink this file: all processes must lock the same inode. OS locks
    // are released on close/crash and never expire while a process is alive.
    return await action();
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (["EACCES", "EPERM", "EROFS"].includes(code ?? ""))
      throw new CredentialStoreError(
        "Cannot access the local credential directory. Check your home-directory permissions or agent sandbox access; the session has not been deleted.",
      );
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function changeCredentialStore(
  baseUrl: string,
  requested: string,
): Promise<void> {
  const selected = parseCredentialStore(requested);
  if (
    process.env.TODOBUD_CREDENTIAL_STORE !== undefined &&
    parseCredentialStore(process.env.TODOBUD_CREDENTIAL_STORE) !== selected
  ) {
    throw new Error(
      "Unset TODOBUD_CREDENTIAL_STORE before selecting a different persistent storage mode.",
    );
  }
  await withCredentialLock(baseUrl, async () => {
    const record = readRecord(baseUrl);
    const stored =
      record?.backend === "file"
        ? record.credentials!
        : record?.backend === "none"
          ? null
          : readKeyring(baseUrl);
    if (stored) {
      saveCredentials(baseUrl, stored, selected);
      if (record?.problem)
        markCredentialProblem(baseUrl, stored, record.problem);
    } else {
      writeRecord({
        version: 1,
        baseUrl,
        mode: selected,
        backend: "none",
        updatedAt: new Date().toISOString(),
      });
      if (record?.cleanupPending) deleteCredentials(baseUrl);
    }
  });
}

export async function recoverCredentials(baseUrl: string): Promise<void> {
  await withCredentialLock(baseUrl, async () => {
    const p = paths(baseUrl);
    const candidates = readdirSync(p.directory)
      .filter(
        (name) =>
          name === `${p.id}.json.recovery` ||
          (name.startsWith(`${p.id}.json.recovery.`) && name.endsWith(".tmp")),
      )
      .map((name) => join(p.directory, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length === 0)
      throw new CredentialStoreError(
        "No recovery copy is available. Run `todobud auth login --storage file` for a new session.",
      );
    const source = candidates[0]!;
    const record = parseRecord(readPrivateFile(source)!, baseUrl);
    if (mode(record) === "keyring" && record.backend === "file")
      throw new CredentialStoreError(
        "Recovery contains file credentials. Select file or auto storage to recover it.",
      );
    const current = readPrivateFile(p.path);
    if (
      current &&
      Date.parse(parseRecord(current, baseUrl).updatedAt) >=
        Date.parse(record.updatedAt)
    ) {
      throw new CredentialStoreError(
        "The active session is newer than the recovery copy; it will not be overwritten.",
      );
    }
    promotePrivateFile(source, p.path);
    for (const candidate of candidates.slice(1)) removePrivateFile(candidate);
  });
}
