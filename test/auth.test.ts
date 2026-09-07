import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizationHeader,
  loginWithBrowser,
  loginWithDevice,
  logout,
} from "../src/auth.js";
import {
  setCredentialBackendForTesting,
  type CredentialBackend,
} from "../src/credentials.js";

process.env.NODE_ENV = "test";
delete process.env.TODOBUD_API_KEY;

function memoryBackend(values = new Map<string, string>()): CredentialBackend {
  return {
    get: (key) => values.get(key) || null,
    set: (key, value) => values.set(key, value),
    delete: (key) => {
      values.delete(key);
    },
  };
}

test("browser login returns to the loopback callback with PKCE", async () => {
  const values = new Map<string, string>();
  setCredentialBackendForTesting(memoryBackend(values));
  process.env.TODOBUD_BASE_URL = "http://127.0.0.1:8000";
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let authorizationUrl: URL | undefined;
  console.log = (message?: unknown) => {
    const text = String(message);
    const candidate = text.match(/https?:\/\/\S+/)?.[0];
    if (candidate?.includes("/oauth/cli/authorize/")) {
      authorizationUrl = new URL(candidate);
    }
  };
  globalThis.fetch = async () =>
    Response.json({
      access_token: "tdb_at_browser",
      refresh_token: "tdb_rt_browser",
      expires_in: 900,
      token_type: "Bearer",
      scope: "todos:read todos:write",
    });
  try {
    const login = loginWithBrowser(false);
    for (let attempt = 0; !authorizationUrl && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(authorizationUrl);
    assert.equal(
      authorizationUrl.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.equal(
      authorizationUrl.searchParams.get("code_challenge")?.length,
      43,
    );
    const callback = new URL(
      authorizationUrl.searchParams.get("redirect_uri")!,
    );
    callback.searchParams.set("code", "one-time-code");
    callback.searchParams.set(
      "state",
      authorizationUrl.searchParams.get("state")!,
    );
    const callbackResponse = await originalFetch(callback);
    assert.equal(callbackResponse.status, 200);
    await login;
    assert.match(values.get("http://127.0.0.1:8000") || "", /tdb_rt_browser/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    delete process.env.TODOBUD_BASE_URL;
  }
});

test("device login polls and stores credentials outside plaintext config", async () => {
  const values = new Map<string, string>();
  setCredentialBackendForTesting(memoryBackend(values));
  process.env.TODOBUD_BASE_URL = "http://127.0.0.1:8000";
  const originalFetch = globalThis.fetch;
  let pollCount = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/device/code/")) {
      return Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "http://127.0.0.1:8000/oauth/cli/device/",
        expires_in: 10,
        interval: 1,
      });
    }
    pollCount += 1;
    if (pollCount === 1) {
      return Response.json(
        { error: "authorization_pending", error_description: "Pending" },
        { status: 400 },
      );
    }
    return Response.json({
      access_token: "tdb_at_access",
      refresh_token: "tdb_rt_refresh",
      expires_in: 900,
      token_type: "Bearer",
      scope: "todos:read todos:write",
    });
  };
  try {
    await loginWithDevice(false);
    const serialized = values.get("http://127.0.0.1:8000");
    assert.ok(serialized);
    assert.match(serialized, /tdb_rt_refresh/);
    assert.equal(pollCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TODOBUD_BASE_URL;
  }
});

test("expired access credentials rotate before use", async () => {
  const values = new Map<string, string>();
  values.set(
    "https://todobud.com",
    JSON.stringify({
      accessToken: "tdb_at_old",
      refreshToken: "tdb_rt_old",
      accessExpiresAt: new Date(0).toISOString(),
      scope: "todos:read",
    }),
  );
  setCredentialBackendForTesting(memoryBackend(values));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      access_token: "tdb_at_new",
      refresh_token: "tdb_rt_new",
      expires_in: 900,
      token_type: "Bearer",
      scope: "todos:read",
    });
  try {
    assert.equal(await authorizationHeader(), "Bearer tdb_at_new");
    assert.match(values.get("https://todobud.com") || "", /tdb_rt_new/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logout revokes the server session before deleting local credentials", async () => {
  const values = new Map<string, string>();
  values.set(
    "https://todobud.com",
    JSON.stringify({
      accessToken: "tdb_at_access",
      refreshToken: "tdb_rt_refresh",
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      scope: "todos:read",
    }),
  );
  setCredentialBackendForTesting(memoryBackend(values));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.ok(values.has("https://todobud.com"));
    assert.match(String(init?.body), /tdb_rt_refresh/);
    return Response.json({});
  };
  try {
    await logout();
    assert.equal(values.has("https://todobud.com"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
