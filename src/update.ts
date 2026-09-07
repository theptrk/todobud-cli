import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

import semver from "semver";

const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/todobud/latest";
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

interface UpdateCache {
  checkedAt: string;
  latest?: string;
}

function cachePath(): string {
  const root = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(root, "todobud", "update.json");
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    return JSON.parse(await readFile(cachePath(), "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: UpdateCache): Promise<void> {
  const path = cachePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(cache), { mode: 0o600 });
}

export async function latestVersion(force = false): Promise<string | null> {
  const cached = await readCache();
  if (
    !force &&
    cached &&
    Date.parse(cached.checkedAt) > Date.now() - CHECK_INTERVAL
  ) {
    return cached.latest || null;
  }
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { version?: string };
    const latest =
      body.version && semver.valid(body.version) ? body.version : undefined;
    await writeCache({
      checkedAt: new Date().toISOString(),
      ...(latest ? { latest } : {}),
    });
    return latest || null;
  } catch {
    await writeCache({ checkedAt: new Date().toISOString() }).catch(
      () => undefined,
    );
    return null;
  }
}

export async function reportUpdate(force = false): Promise<void> {
  const latest = await latestVersion(force);
  const current = packageJson.version;
  if (!latest) {
    if (force)
      console.log(`Installed: ${current}\nUnable to check npm for updates.`);
    return;
  }
  if (semver.gt(latest, current)) {
    const message =
      `TodoBud CLI ${latest} is available (installed: ${current}).\n` +
      "Update with: npm install -g todobud@latest";
    if (force) console.log(message);
    else console.error(message);
  } else if (force) {
    console.log(`TodoBud CLI ${current} is up to date.`);
  }
}

export async function automaticUpdateCheck(): Promise<void> {
  if (
    process.env.CI ||
    process.env.NO_UPDATE_NOTIFIER ||
    process.env.TODOBUD_DISABLE_UPDATE_CHECK === "1" ||
    !process.stderr.isTTY
  ) {
    return;
  }
  await reportUpdate(false);
}

export function currentVersion(): string {
  return packageJson.version;
}
