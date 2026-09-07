const DEFAULT_BASE_URL = "https://todobud.com";

export function getBaseUrl(): string {
  const value = (process.env.TODOBUD_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const parsed = new URL(value);
  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(
    parsed.hostname,
  );
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback)
  ) {
    throw new Error(
      "TODOBUD_BASE_URL must use HTTPS (HTTP is allowed only for localhost).",
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "TODOBUD_BASE_URL must be an origin without credentials, a path, query parameters, or a fragment.",
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

export const CLIENT_ID = "todobud-cli";
export const DEFAULT_SCOPES = "todos:read todos:write";
