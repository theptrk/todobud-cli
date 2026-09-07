import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apiRequest, listAll, redact } from "../src/api.js";
import { getBaseUrl } from "../src/config.js";
import { parseData } from "../src/resources.js";
import { latestVersion } from "../src/update.js";

test("configuration permits HTTPS and local HTTP only", () => {
  process.env.TODOBUD_BASE_URL = "https://example.com/";
  assert.equal(getBaseUrl(), "https://example.com");
  process.env.TODOBUD_BASE_URL = "http://127.0.0.1:8000";
  assert.equal(getBaseUrl(), "http://127.0.0.1:8000");
  process.env.TODOBUD_BASE_URL = "http://example.com";
  assert.throws(() => getBaseUrl(), /must use HTTPS/);
  process.env.TODOBUD_BASE_URL = "https://example.com/api";
  assert.throws(() => getBaseUrl(), /must be an origin/);
  delete process.env.TODOBUD_BASE_URL;
});

test("JSON data parsing requires an object", () => {
  assert.deepEqual(parseData('{"title":"Test"}'), { title: "Test" });
  assert.throws(() => parseData("[]"), /JSON object/);
  assert.throws(() => parseData("{"), /valid JSON/);
});

test("credential-shaped values are redacted", () => {
  assert.equal(redact("bad tdb_at_topsecret"), "bad [REDACTED]");
  assert.equal(redact("bad tdb_012345abcdef_topsecret"), "bad [REDACTED]");
});

test("API requests authenticate and follow pagination", async () => {
  process.env.TODOBUD_API_KEY = "secret";
  process.env.TODOBUD_BASE_URL = "https://example.com";
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      "Api-Key secret",
    );
    const page =
      calls.length === 1
        ? {
            next: "https://example.com/api/v1/todos/?page=2",
            results: [{ id: 1 }],
          }
        : { next: null, results: [{ id: 2 }] };
    return Response.json(page);
  };
  try {
    assert.deepEqual(await listAll("todos/"), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(calls, [
      "https://example.com/api/v1/todos/",
      "https://example.com/api/v1/todos/?page=2",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TODOBUD_API_KEY;
    delete process.env.TODOBUD_BASE_URL;
  }
});

test("API errors never expose returned TodoBud credentials", async () => {
  process.env.TODOBUD_API_KEY = "secret";
  process.env.TODOBUD_BASE_URL = "https://example.com";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { detail: "Rejected tdb_rt_thismustnotleak" },
      { status: 401 },
    );
  try {
    await assert.rejects(
      () => apiRequest("GET", "todos/"),
      (error: Error) =>
        error.message === "Rejected [REDACTED]" &&
        !error.message.includes("thismustnotleak"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TODOBUD_API_KEY;
    delete process.env.TODOBUD_BASE_URL;
  }
});

test("update checks cache valid npm metadata", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "todobud-update-"));
  process.env.XDG_CACHE_HOME = cacheRoot;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ version: "99.0.0" });
  };
  try {
    assert.equal(await latestVersion(true), "99.0.0");
    assert.equal(await latestVersion(false), "99.0.0");
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.XDG_CACHE_HOME;
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
