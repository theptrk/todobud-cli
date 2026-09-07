import { authorizationHeader } from "./auth.js";
import { getBaseUrl } from "./config.js";

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
): Promise<Response> {
  const authorization = await authorizationHeader(forceRefresh);
  return fetch(`${getBaseUrl()}/api/v1/${path.replace(/^\/+/, "")}`, {
    method,
    headers: {
      authorization,
      accept: "application/json",
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
): Promise<T> {
  let response = await performRequest(method, path, body, false);
  if (response.status === 401 && !process.env.TODOBUD_API_KEY) {
    response = await performRequest(method, path, body, true);
  }
  if (response.status === 204) return undefined as T;
  const responseBody = (await response
    .json()
    .catch(() => undefined)) as unknown;
  if (!response.ok) {
    throw new APIError(
      errorMessage(responseBody, response.status),
      response.status,
    );
  }
  return responseBody as T;
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
