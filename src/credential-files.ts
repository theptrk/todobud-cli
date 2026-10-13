import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

export class CredentialStoreError extends Error {
  constructor(
    message: string,
    readonly recoveryAvailable = false,
  ) {
    super(message);
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function checkType(stat: Stats, directory: boolean): void {
  if (
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    (!directory && stat.nlink !== 1) ||
    (process.platform !== "win32" && stat.uid !== process.getuid!())
  ) {
    throw new CredentialStoreError(
      "Unsafe credential path: expected an owned directory or regular file with one link. " +
        "Symlinks, hard links, and files owned by another user are refused.",
    );
  }
}

// Pass the path over stdin, never as interpolated PowerShell code. Use an exact
// owner-only DACL (including inheritable rules for a directory), not chmod on
// Windows. Existing explicit grants and inherited grants are both removed.
function restrictWindows(path: string, directory: boolean): void {
  const script = `
    $ErrorActionPreference = 'Stop'
    $p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([Console]::In.ReadToEnd()))
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User
    $old = [System.IO.${directory ? "Directory" : "File"}]::GetAccessControl($p)
    $owner = $old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value) { throw 'Unexpected owner' }
    $acl = [System.Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'${directory ? "ContainerInherit, ObjectInherit" : "None"}', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    [System.IO.${directory ? "Directory" : "File"}]::SetAccessControl($p, $acl)
    $saved = [System.IO.${directory ? "Directory" : "File"}]::GetAccessControl($p)
    $rules = $saved.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    if (-not $saved.AreAccessRulesProtected -or $saved.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'ACL verification failed' }
  `;
  try {
    execFileSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        input: Buffer.from(path, "utf8").toString("base64"),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 10_000,
      },
    );
  } catch (error) {
    const diagnostic = String((error as { stderr?: unknown }).stderr ?? "");
    const errorId = diagnostic.match(
      /FullyQualifiedErrorId\s*:\s*([A-Za-z0-9_,.:-]+)/,
    )?.[1];
    const reason = diagnostic.includes("Unexpected owner")
      ? " (unexpected file owner)"
      : errorId
        ? ` (${errorId.slice(0, 160)})`
        : "";
    throw new CredentialStoreError(
      `Unable to enforce owner-only Windows credential access${reason}. Check your profile permissions and PowerShell availability.`,
    );
  }
}

// Revalidate each object once per process. Creation/replacement changes its
// identity; repeated reads under the session lock need no new PowerShell
// process. Type/link checks below still run on every access.
const securedWindowsPaths = new Map<string, string>();

export function securePath(path: string, directory = false): void {
  const stat = lstatSync(path);
  checkType(stat, directory);
  if (process.platform === "win32") {
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (securedWindowsPaths.get(path) !== identity) {
      restrictWindows(path, directory);
      securedWindowsPaths.set(path, identity);
    }
  } else chmodSync(path, directory ? 0o700 : 0o600);
}

export function ensureDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  securePath(path, true);
}

export function readPrivateFile(path: string): string | null {
  let fd: number | undefined;
  try {
    securePath(path);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    checkType(stat, false);
    if (stat.size > 64 * 1024)
      throw new CredentialStoreError("Credential file is too large.");
    return readFileSync(fd, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function removePrivateFile(path: string): void {
  try {
    securePath(path);
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// A failed rename retains the fully written temporary file and reports its
// location without including any credentials. Never truncate the old file.
export function atomicPrivateWrite(path: string, value: string): void {
  try {
    securePath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let complete = false;
  try {
    securePath(temporary);
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) removePrivateFile(temporary);
  }
  try {
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch {
    throw new CredentialStoreError(
      `Credential write could not be committed. The restricted recovery copy is at ${temporary}. Run \`todobud auth recover\` after restoring directory access.`,
      true,
    );
  }
}

export function promotePrivateFile(from: string, to: string): void {
  securePath(from);
  try {
    securePath(to);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  renameSync(from, to);
  syncDirectory(dirname(to));
}
