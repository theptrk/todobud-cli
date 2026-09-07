import { createServer, type Server } from "node:http";

import open from "open";
import * as client from "openid-client";

import { CLIENT_ID, DEFAULT_SCOPES, getBaseUrl } from "./config.js";
import {
  deleteCredentials,
  loadCredentials,
  saveCredentials,
  type StoredCredentials,
} from "./credentials.js";

function oauthConfiguration(baseUrl = getBaseUrl()): client.Configuration {
  const configuration = new client.Configuration(
    {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/o/authorize/`,
      token_endpoint: `${baseUrl}/o/token/`,
      revocation_endpoint: `${baseUrl}/o/revoke_token/`,
      device_authorization_endpoint: `${baseUrl}/o/device-authorization/`,
    },
    CLIENT_ID,
  );
  if (new URL(baseUrl).protocol === "http:") {
    client.allowInsecureRequests(configuration);
  }
  return configuration;
}

function toStored(tokens: client.TokenEndpointResponse): StoredCredentials {
  const expiresIn =
    typeof tokens.expires_in === "number" ? tokens.expires_in : 900;
  return {
    accessToken: tokens.access_token,
    refreshToken: String(tokens.refresh_token),
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: typeof tokens.scope === "string" ? tokens.scope : DEFAULT_SCOPES,
  };
}

function oauthErrorCode(error: unknown): string | undefined {
  return error instanceof client.ResponseBodyError ? error.error : undefined;
}

async function revokeExisting(
  configuration: client.Configuration,
  baseUrl: string,
): Promise<void> {
  const existing = loadCredentials(baseUrl);
  if (!existing) return;
  await client.tokenRevocation(configuration, existing.refreshToken, {
    token_type_hint: "refresh_token",
  });
  deleteCredentials(baseUrl);
}

function waitForAuthorization(
  server: Server,
  expectedState: string,
  redirectUri: string,
): Promise<URL> {
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
      const currentUrl = new URL(request.url || "/", redirectUri);
      if (currentUrl.pathname !== "/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const state = currentUrl.searchParams.get("state");
      const code = currentUrl.searchParams.get("code");
      const error = currentUrl.searchParams.get("error");
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
      else resolve(currentUrl);
    });
  });
}

function verificationUri(
  device: client.DeviceAuthorizationResponse,
  baseUrl: string,
): string {
  const raw = device.verification_uri_complete || device.verification_uri;
  return new URL(raw, `${baseUrl}/`).toString();
}

export async function loginWithBrowser(openBrowser = true): Promise<void> {
  const baseUrl = getBaseUrl();
  const configuration = oauthConfiguration(baseUrl);
  await revokeExisting(configuration, baseUrl);
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
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
  const authorizationUrl = client.buildAuthorizationUrl(configuration, {
    redirect_uri: redirectUri,
    scope: DEFAULT_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  console.log(`Opening ${authorizationUrl.origin} to authorize TodoBud CLI.`);
  console.log(
    `If the browser does not open, visit:\n${authorizationUrl.toString()}`,
  );
  const authorization = waitForAuthorization(server, state, redirectUri);
  if (openBrowser) {
    try {
      await open(authorizationUrl.toString());
    } catch {
      // The printable URL is the supported fallback.
    }
  }
  const tokens = await client.authorizationCodeGrant(
    configuration,
    await authorization,
    {
      pkceCodeVerifier: verifier,
      expectedState: state,
    },
    { redirect_uri: redirectUri },
  );
  saveCredentials(baseUrl, toStored(tokens));
  console.log(
    "Logged in. Credentials are stored in your operating-system keychain.",
  );
}

export async function loginWithDevice(openBrowser = true): Promise<void> {
  const baseUrl = getBaseUrl();
  const configuration = oauthConfiguration(baseUrl);
  await revokeExisting(configuration, baseUrl);
  const device = await client.initiateDeviceAuthorization(configuration, {
    scope: DEFAULT_SCOPES,
  });
  const uri = verificationUri(device, baseUrl);
  console.log(`Visit ${uri}`);
  console.log(`Enter code: ${device.user_code}`);
  if (openBrowser) {
    try {
      await open(uri);
    } catch {
      // The printable URL is the supported fallback.
    }
  }

  const tokens = await client.pollDeviceAuthorizationGrant(
    configuration,
    device,
  );
  saveCredentials(baseUrl, toStored(tokens));
  console.log(
    "Logged in. Credentials are stored in your operating-system keychain.",
  );
}

async function refresh(
  configuration: client.Configuration,
  baseUrl: string,
  stored: StoredCredentials,
): Promise<StoredCredentials> {
  try {
    const tokens = await client.refreshTokenGrant(
      configuration,
      stored.refreshToken,
    );
    const next = toStored(tokens);
    saveCredentials(baseUrl, next);
    return next;
  } catch (error) {
    if (oauthErrorCode(error) === "invalid_grant") {
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
    stored = await refresh(oauthConfiguration(baseUrl), baseUrl, stored);
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
  await client.tokenRevocation(
    oauthConfiguration(baseUrl),
    stored.refreshToken,
    {
      token_type_hint: "refresh_token",
    },
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
