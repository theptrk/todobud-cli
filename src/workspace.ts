import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBaseUrl } from "./config.js";

export interface Workspace {
  id: number;
  kind: "personal" | "team";
  slug: string | null;
  name: string;
}
let override: string | undefined;
export function selectWorkspace(value: string | undefined): void {
  override = value;
}
export function workspaceLabel(workspace: Workspace): string {
  return `${workspace.kind === "personal" ? "personal" : workspace.slug} (#${workspace.id})`;
}
function configPath(): string {
  return join(process.cwd(), ".todobud.json");
}
interface ProjectConfig {
  server: string;
  workspace: number | "personal";
}
async function readProjectConfig(): Promise<ProjectConfig | undefined> {
  let contents: string;
  try {
    contents = await readFile(configPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let saved: unknown;
  try {
    saved = JSON.parse(contents);
  } catch {
    throw new Error(
      "Invalid .todobud.json: expected JSON with server and workspace.",
    );
  }
  if (
    !saved ||
    typeof saved !== "object" ||
    Array.isArray(saved) ||
    Object.keys(saved).some((key) => !["server", "workspace"].includes(key)) ||
    !("server" in saved) ||
    typeof saved.server !== "string" ||
    !("workspace" in saved) ||
    !(
      saved.workspace === "personal" ||
      (typeof saved.workspace === "number" &&
        Number.isSafeInteger(saved.workspace) &&
        saved.workspace > 0)
    )
  ) {
    throw new Error(
      "Invalid .todobud.json: expected server and a positive workspace ID or personal.",
    );
  }
  if (saved.server !== getBaseUrl()) {
    throw new Error(
      "The .todobud.json server does not match TODOBUD_BASE_URL. Choose the matching server or use --workspace explicitly.",
    );
  }
  return saved as ProjectConfig;
}
function selection(identifier: string): { identifier: string; label: string } {
  identifier = identifier.trim();
  if (!identifier) throw new Error("Workspace selection cannot be empty.");
  return { identifier, label: identifier };
}
export async function workspaceSelection(): Promise<{
  identifier: string;
  label: string;
}> {
  if (override !== undefined) return selection(override);
  if (process.env.TODOBUD_WORKSPACE !== undefined)
    return selection(process.env.TODOBUD_WORKSPACE);
  const saved = await readProjectConfig();
  return selection(saved ? String(saved.workspace) : "personal");
}
export async function saveWorkspace(workspace: Workspace): Promise<void> {
  if (
    !Number.isSafeInteger(workspace.id) ||
    workspace.id <= 0 ||
    !["personal", "team"].includes(workspace.kind)
  )
    throw new Error("Server returned an invalid workspace.");
  // Refuse to overwrite malformed or differently scoped project configuration.
  await readProjectConfig();
  const saved: ProjectConfig = {
    server: getBaseUrl(),
    workspace: workspace.kind === "personal" ? "personal" : workspace.id,
  };
  const path = configPath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(saved, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
