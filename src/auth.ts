import { createServer, type Server } from "node:http";

import open from "open";
import * as client from "openid-client";

import { CLIENT_ID, DEFAULT_SCOPES, getBaseUrl } from "./config.js";
import {
  deleteCredentials,
  credentialInfo,
  CredentialStoreError,
  loadCredentials,
  markCredentialProblem,
  parseCredentialStore,
  saveCredentials,
  withCredentialLock,
  type CredentialStore,
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
  configuration.timeout = 30;
  return configuration;
}

function toStored(
  tokens: client.TokenEndpointResponse,
  previous?: StoredCredentials,
): StoredCredentials {
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error(
      "The authorization server did not return a refresh token; the existing session has not been deleted.",
    );
  }
  const expiresIn =
    typeof tokens.expires_in === "number" &&
    Number.isFinite(tokens.expires_in) &&
    tokens.expires_in > 0
      ? tokens.expires_in
      : 900;
  return {
    accessToken: tokens.access_token,
    refreshToken,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope:
      typeof tokens.scope === "string"
        ? tokens.scope
        : (previous?.scope ?? DEFAULT_SCOPES),
  };
}

function oauthErrorCode(error: unknown): string | undefined {
  return error instanceof client.ResponseBodyError ? error.error : undefined;
}

function requestedStorage(storage?: string): CredentialStore | undefined {
  const requested =
    storage === undefined ? undefined : parseCredentialStore(storage);
  const override = process.env.TODOBUD_CREDENTIAL_STORE;
  if (
    requested !== undefined &&
    override !== undefined &&
    parseCredentialStore(override) !== requested
  ) {
    throw new Error(
      "Unset TODOBUD_CREDENTIAL_STORE before selecting a different persistent storage mode.",
    );
  }
  return requested;
}

async function completeLogin(
  baseUrl: string,
  tokens: client.TokenEndpointResponse,
  requested?: CredentialStore,
): Promise<void> {
  await withCredentialLock(baseUrl, async () => {
    let previous: StoredCredentials | null = null;
    try {
      previous = loadCredentials(baseUrl);
    } catch (error) {
      if (!(error instanceof CredentialStoreError)) throw error;
    }
    const next = toStored(tokens);
    saveCredentials(baseUrl, next, requested, true);
    if (previous && previous.refreshToken !== next.refreshToken) {
      try {
        await client.tokenRevocation(
          oauthConfiguration(baseUrl),
          previous.refreshToken,
          { token_type_hint: "refresh_token" },
        );
      } catch {
        console.error(
          "The new login is saved, but the previous session could not be revoked. Revoke older devices from Profile → Authorized CLIs.",
        );
      }
    }
  });
  const info = credentialInfo(baseUrl);
  console.log(
    `Logged in. Credential storage: ${info.backend} (mode: ${info.mode})${info.backend === "file" ? ` at ${info.path}` : ""}.`,
  );
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

export async function loginWithBrowser(
  openBrowser = true,
  storage?: string,
): Promise<void> {
  const baseUrl = getBaseUrl();
  const configuration = oauthConfiguration(baseUrl);
  const requested = requestedStorage(storage);
  // Check that coordination/local metadata are writable before authorization.
  await withCredentialLock(baseUrl, async () => {});
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
  await completeLogin(baseUrl, tokens, requested);
}

export async function loginWithDevice(
  openBrowser = true,
  storage?: string,
): Promise<void> {
  const baseUrl = getBaseUrl();
  const configuration = oauthConfiguration(baseUrl);
  const requested = requestedStorage(storage);
  await withCredentialLock(baseUrl, async () => {});
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
  await completeLogin(baseUrl, tokens, requested);
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
    const next = toStored(tokens, stored);
    try {
      saveCredentials(baseUrl, next);
    } catch (error) {
      // Keep the previous copy and a durable diagnostic when possible. Auto
      // storage has already attempted the restricted file fallback; failed
      // commits retain their recovery copy. Keyring-only never writes tokens
      // to a file, even during recovery.
      if (!(error instanceof CredentialStoreError && error.recoveryAvailable)) {
        try {
          markCredentialProblem(baseUrl, stored, "refresh-save-failed");
        } catch {
          /* Report the original save failure. */
        }
      }
      const detail =
        error instanceof Error
          ? error.message
          : "Credential persistence failed.";
      throw new CredentialStoreError(
        `The server refreshed the session, but saving it failed. The previous session was not deleted and may no longer refresh. ${detail} Run \`todobud auth recover\` if a recovery copy was saved, or \`todobud auth login --storage file\`.`,
      );
    }
    return next;
  } catch (error) {
    if (oauthErrorCode(error) === "invalid_grant") {
      // Never delete credentials on invalid_grant. All updated clients share
      // the lock; retain the rejected copy for status/revocation/recovery.
      const current = loadCredentials(baseUrl);
      if (
        current &&
        (current.refreshToken !== stored.refreshToken ||
          current.accessToken !== stored.accessToken)
      )
        return current;
      try {
        markCredentialProblem(baseUrl, stored, "expired");
      } catch {
        /* Keep useful expiry feedback if metadata is unavailable. */
      }
      throw new Error(
        "This CLI session expired or was revoked. Stored credentials were retained. Run `todobud auth login` to authorize a new session.",
      );
    }
    throw error;
  }
}

export async function authorizationHeader(
  forceRefresh = false,
  rejectedAuthorization?: string,
): Promise<string> {
  const apiKey = process.env.TODOBUD_API_KEY;
  if (apiKey) return `Api-Key ${apiKey}`;
  const baseUrl = getBaseUrl();
  const stored = await withCredentialLock(baseUrl, async () => {
    // Another process may have refreshed, re-logged in, migrated, or logged
    // out while this process waited for the lock.
    const current = loadCredentials(baseUrl);
    if (!current)
      throw new Error(
        "No accessible CLI session. Run `todobud auth login`. If already signed in from another terminal, check Keychain or agent sandbox access; `todobud auth storage file` can migrate an accessible session.",
      );
    const info = credentialInfo(baseUrl);
    if (info.problem === "expired")
      throw new Error(
        "This CLI session expired or was revoked. Run `todobud auth login`.",
      );
    if (info.problem === "refresh-save-failed")
      throw new CredentialStoreError(
        "A previous refresh succeeded but could not be saved. Run `todobud auth recover`, or `todobud auth login --storage file`. Stored credentials were retained.",
      );
    const mustForce =
      forceRefresh &&
      current.accessToken ===
        (rejectedAuthorization?.replace(/^Bearer /, "") ?? current.accessToken);
    return mustForce ||
      Date.parse(current.accessExpiresAt) <= Date.now() + 30_000
      ? refresh(oauthConfiguration(baseUrl), baseUrl, current)
      : current;
  });
  return `Bearer ${stored.accessToken}`;
}

export async function logout(): Promise<void> {
  if (process.env.TODOBUD_API_KEY) {
    throw new Error(
      "TODOBUD_API_KEY is managed in the environment. Revoke it from Profile → API Keys.",
    );
  }
  const baseUrl = getBaseUrl();
  await withCredentialLock(baseUrl, async () => {
    const stored = loadCredentials(baseUrl);
    if (stored) {
      await client.tokenRevocation(
        oauthConfiguration(baseUrl),
        stored.refreshToken,
        { token_type_hint: "refresh_token" },
      );
    }
    deleteCredentials(baseUrl);
    console.log(
      stored
        ? "Logged out and revoked this CLI session."
        : "Already logged out; stale-copy cleanup attempted.",
    );
  });
}

export async function authStatus(): Promise<void> {
  if (process.env.TODOBUD_API_KEY) {
    console.log("Authenticated with TODOBUD_API_KEY.");
    return;
  }
  const baseUrl = getBaseUrl();
  await withCredentialLock(baseUrl, async () => {
    const stored = loadCredentials(baseUrl);
    const info = credentialInfo(baseUrl);
    console.log(
      `Server: ${baseUrl}. Credential storage: ${info.backend} (mode: ${info.mode})${info.backend === "file" ? ` at ${info.path}` : ""}.`,
    );
    if (info.cleanupPending)
      console.log(
        "Stale Keychain cleanup is pending; that copy is never selected.",
      );
    if (!stored)
      console.log(
        "Not logged in. If signed in elsewhere, check credential-store or sandbox access.",
      );
    else if (info.problem === "expired")
      console.log("Session expired or revoked. Run `todobud auth login`.");
    else if (info.problem === "refresh-save-failed")
      console.log(
        "Refresh succeeded but could not be saved. Run `todobud auth recover` or `todobud auth login --storage file`.",
      );
    else
      console.log(
        `Logged in with browser authorization (scopes: ${stored.scope}). Access token ${Date.parse(stored.accessExpiresAt) <= Date.now() + 30_000 ? "will refresh automatically on the next request" : "is current"}.`,
      );
  });
}
