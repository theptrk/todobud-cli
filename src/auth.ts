import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { hostname, platform } from "node:os";

import open from "open";

import { CLIENT_ID, DEFAULT_SCOPES, getBaseUrl } from "./config.js";
import {
  deleteCredentials,
  loadCredentials,
  saveCredentials,
  type StoredCredentials,
} from "./credentials.js";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
  scope: string;
}

interface DeviceResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function deviceName(): string {
  return `${hostname()} (${platform()})`.slice(0, 100);
}

function toStored(tokens: TokenResponse): StoredCredentials {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAt: new Date(
      Date.now() + tokens.expires_in * 1000,
    ).toISOString(),
    scope: tokens.scope,
  };
}

async function oauthRequest<T>(
  path: string,
  values: Record<string, string>,
  baseUrl = getBaseUrl(),
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as T & OAuthErrorBody;
  if (!response.ok) {
    throw new OAuthError(
      body.error || "authorization_error",
      body.error_description ||
        `Authorization failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  return body;
}

async function revokeExisting(baseUrl: string): Promise<void> {
  const existing = loadCredentials(baseUrl);
  if (!existing) return;
  await oauthRequest<Record<string, never>>(
    "/oauth/cli/revoke/",
    { token: existing.refreshToken },
    baseUrl,
  );
  deleteCredentials(baseUrl);
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function waitForAuthorization(
  server: Server,
  expectedState: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        server.close();
        reject(
          new Error("Browser authorization timed out after five minutes."),
        );
      },
      5 * 60 * 1000,
    );
    timer.unref();

    server.on("request", (request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const state = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");
      const valid = state === expectedState && Boolean(code) && !error;
      response.writeHead(valid ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        valid
          ? "<h1>TodoBud CLI is authorized</h1><p>You may close this window and return to the terminal.</p>"
          : "<h1>Authorization failed</h1><p>Return to the terminal and try again.</p>",
      );
      clearTimeout(timer);
      server.close();
      if (error) reject(new Error(`Authorization was denied (${error}).`));
      else if (state !== expectedState)
        reject(new Error("Authorization state did not match."));
      else if (!code)
        reject(new Error("Authorization response did not contain a code."));
      else resolve(code);
    });
  });
}

export async function loginWithBrowser(openBrowser = true): Promise<void> {
  const baseUrl = getBaseUrl();
  await revokeExisting(baseUrl);
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(32));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start the local authorization callback.");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const authorizationUrl = new URL("/oauth/cli/authorize/", baseUrl);
  authorizationUrl.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: DEFAULT_SCOPES,
    device_name: deviceName(),
  }).toString();

  console.log(`Opening ${authorizationUrl.origin} to authorize TodoBud CLI.`);
  console.log(
    `If the browser does not open, visit:\n${authorizationUrl.toString()}`,
  );
  const authorization = waitForAuthorization(server, state);
  if (openBrowser) {
    try {
      await open(authorizationUrl.toString());
    } catch {
      // The printable URL is the supported fallback.
    }
  }
  const code = await authorization;
  const tokens = await oauthRequest<TokenResponse>(
    "/oauth/cli/token/",
    {
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
    baseUrl,
  );
  saveCredentials(baseUrl, toStored(tokens));
  console.log(
    "Logged in. Credentials are stored in your operating-system keychain.",
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function loginWithDevice(openBrowser = true): Promise<void> {
  const baseUrl = getBaseUrl();
  await revokeExisting(baseUrl);
  const device = await oauthRequest<DeviceResponse>(
    "/oauth/cli/device/code/",
    {
      client_id: CLIENT_ID,
      scope: DEFAULT_SCOPES,
      device_name: deviceName(),
    },
    baseUrl,
  );
  console.log(`Visit ${device.verification_uri}`);
  console.log(`Enter code: ${device.user_code}`);
  if (openBrowser) {
    try {
      await open(device.verification_uri);
    } catch {
      // The printable URL is the supported fallback.
    }
  }

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = Math.max(device.interval, 1);
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    try {
      const tokens = await oauthRequest<TokenResponse>(
        "/oauth/cli/token/",
        {
          client_id: CLIENT_ID,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.device_code,
        },
        baseUrl,
      );
      saveCredentials(baseUrl, toStored(tokens));
      console.log(
        "Logged in. Credentials are stored in your operating-system keychain.",
      );
      return;
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.code === "authorization_pending") continue;
      if (error.code === "slow_down") {
        interval += 5;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Device authorization expired.");
}

async function refresh(
  baseUrl: string,
  stored: StoredCredentials,
): Promise<StoredCredentials> {
  try {
    const tokens = await oauthRequest<TokenResponse>(
      "/oauth/cli/token/",
      {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      },
      baseUrl,
    );
    const next = toStored(tokens);
    saveCredentials(baseUrl, next);
    return next;
  } catch (error) {
    if (error instanceof OAuthError && error.code === "invalid_grant") {
      deleteCredentials(baseUrl);
    }
    throw error;
  }
}

export async function authorizationHeader(
  forceRefresh = false,
): Promise<string> {
  const apiKey = process.env.TODOBUD_API_KEY;
  if (apiKey) return `Api-Key ${apiKey}`;
  const baseUrl = getBaseUrl();
  let stored = loadCredentials(baseUrl);
  if (!stored) {
    throw new Error(
      "Not logged in. Run `todobud auth login` or set TODOBUD_API_KEY.",
    );
  }
  if (
    forceRefresh ||
    Date.parse(stored.accessExpiresAt) <= Date.now() + 30_000
  ) {
    stored = await refresh(baseUrl, stored);
  }
  return `Bearer ${stored.accessToken}`;
}

export async function logout(): Promise<void> {
  if (process.env.TODOBUD_API_KEY) {
    throw new Error(
      "TODOBUD_API_KEY is managed in the environment. Revoke it from Profile → API Keys.",
    );
  }
  const baseUrl = getBaseUrl();
  const stored = loadCredentials(baseUrl);
  if (!stored) {
    console.log("Already logged out.");
    return;
  }
  await oauthRequest<Record<string, never>>(
    "/oauth/cli/revoke/",
    { token: stored.refreshToken },
    baseUrl,
  );
  deleteCredentials(baseUrl);
  console.log("Logged out and revoked this CLI session.");
}

export function authStatus(): void {
  if (process.env.TODOBUD_API_KEY) {
    console.log("Authenticated with TODOBUD_API_KEY.");
    return;
  }
  const stored = loadCredentials(getBaseUrl());
  if (!stored) {
    console.log("Not logged in.");
    return;
  }
  console.log(
    `Logged in with browser authorization (scopes: ${stored.scope}).`,
  );
}
