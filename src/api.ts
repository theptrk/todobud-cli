import { authorizationHeader } from "./auth.js";
import { getBaseUrl } from "./config.js";
import {
  workspaceSelection,
  workspaceLabel,
  type Workspace,
} from "./workspace.js";

export type JsonObject = Record<string, unknown>;

export class APIError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function redact(value: string): string {
  return value
    .replace(/tdb_(?:at|rt|ac|dc)_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/tdb_[a-f0-9]{12}_[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.detail === "string") return redact(record.detail);
    return redact(JSON.stringify(record));
  }
  return `TodoBud API request failed with HTTP ${status}.`;
}

async function performRequest(
  method: string,
  path: string,
  body: JsonObject | undefined,
  forceRefresh: boolean,
  workspace?: string,
): Promise<Response> {
  const authorization = await authorizationHeader(forceRefresh);
  return fetch(`${getBaseUrl()}/api/v1/${path.replace(/^\/+/, "")}`, {
    method,
    headers: {
      authorization,
      accept: "application/json",
      ...(workspace !== undefined ? { "X-Workspace": workspace } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: JsonObject,
  options?: { workspace?: string; skipDefault?: boolean; label?: string },
): Promise<T> {
  const selection = options?.skipDefault
    ? {
        identifier: options.workspace,
        label: options.label ?? options.workspace,
      }
    : options?.workspace !== undefined
      ? {
          identifier: options.workspace,
          label: options.label ?? options.workspace,
        }
      : await workspaceSelection();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  let identifier = selection.identifier;
  let expectedWorkspace: Workspace | undefined;
  if (mutation) {
    if (!identifier?.trim()) {
      throw new Error("Workspace selection cannot be empty.");
    }
    // Resolve before writing, then pin the integer id so a renamed/reassigned
    // slug cannot retarget the mutation between discovery and submission.
    const resolved = await resolveWorkspace(identifier);
    expectedWorkspace = resolved;
    identifier = String(resolved.id);
  }
  const header = identifier === "personal" ? undefined : identifier;
  let response = await performRequest(method, path, body, false, header);
  if (response.status === 401 && !process.env.TODOBUD_API_KEY) {
    response = await performRequest(method, path, body, true, header);
  }
  const responseBody =
    response.status === 204
      ? undefined
      : ((await response.json().catch(() => undefined)) as unknown);
  if (!response.ok) {
    const detail =
      response.status === 404 && selection.label !== undefined
        ? `Workspace ${JSON.stringify(selection.label)} or the requested resource is unavailable. Check --workspace, TODOBUD_WORKSPACE, or .todobud.json. `
        : "";
    throw new APIError(
      detail + errorMessage(responseBody, response.status),
      response.status,
    );
  }
  if (mutation) {
    const id = response.headers.get("X-Workspace-ID");
    const kind = response.headers.get("X-Workspace-Kind");
    const slug = response.headers.get("X-Workspace-Slug");
    if (
      id !== identifier ||
      kind !== expectedWorkspace?.kind ||
      (kind === "team" && !slug?.trim())
    ) {
      throw new Error(
        "The write succeeded but the server did not confirm the expected workspace. Verify it before retrying.",
      );
    }
    // Keep stdout valid JSON when --json is used; receipts go to stderr.
    console.error(
      `Workspace: ${workspaceLabel({ id: Number(id), kind: kind as Workspace["kind"], slug, name: "" })}`,
    );
  }
  return responseBody as T;
}

export async function resolveWorkspace(identifier: string): Promise<Workspace> {
  identifier = identifier.trim();
  if (!identifier) throw new Error("Workspace selection cannot be empty.");
  const numeric = /^\d+$/.test(identifier);
  const resolved = await apiRequest<Workspace | null>(
    "GET",
    "workspaces/current/",
    undefined,
    { workspace: identifier, skipDefault: true },
  );
  if (
    !resolved ||
    !Number.isSafeInteger(resolved.id) ||
    resolved.id <= 0 ||
    !["personal", "team"].includes(resolved.kind) ||
    (resolved.kind === "team" &&
      (typeof resolved.slug !== "string" || !resolved.slug.trim())) ||
    (identifier === "personal" && resolved.kind !== "personal") ||
    (identifier !== "personal" && !numeric && resolved.kind !== "team") ||
    (numeric && String(resolved.id) !== String(Number(identifier)))
  )
    throw new Error("Server returned an invalid workspace.");
  return resolved;
}

interface Page<T> {
  next: string | null;
  results: T[];
}

export async function listAll<T>(path: string): Promise<T[]> {
  const results: T[] = [];
  let nextPath: string | null = path;
  while (nextPath) {
    const page: Page<T> = await apiRequest<Page<T>>("GET", nextPath);
    results.push(...page.results);
    if (!page.next) break;
    const nextUrl = new URL(page.next);
    nextPath = `${nextUrl.pathname.replace(/^\/api\/v1\//, "")}${nextUrl.search}`;
  }
  return results;
}
