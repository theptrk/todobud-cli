import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { apiRequest } from "../src/api.js";
import {
  saveWorkspace,
  selectWorkspace,
  workspaceSelection,
} from "../src/workspace.js";

async function withProject(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "todobud-workspace-test-"));
  const previousDirectory = process.cwd();
  const previousEnv = { ...process.env };
  process.chdir(directory);
  process.env.TODOBUD_BASE_URL = "https://example.test";
  process.env.TODOBUD_API_KEY = "test";
  delete process.env.TODOBUD_WORKSPACE;
  selectWorkspace(undefined);
  try {
    await run(directory);
  } finally {
    selectWorkspace(undefined);
    process.env = previousEnv;
    process.chdir(previousDirectory);
    await rm(directory, { recursive: true, force: true });
  }
}

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} pins resolved ID and echoes the server receipt`, async () => {
    process.env.TODOBUD_API_KEY = "test";
    selectWorkspace("old-slug");
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (line: string) => {
      lines.push(line);
    };
    const calls: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const header = (init?.headers as Record<string, string>)["X-Workspace"];
      calls.push(header);
      if (init?.method === "GET")
        return Response.json({
          id: 12,
          kind: "team",
          slug: "renamed",
          name: "Team",
        });
      assert.equal(init?.method, method);
      return new Response(null, {
        status: 204,
        headers: {
          "X-Workspace-ID": "12",
          "X-Workspace-Kind": "team",
          "X-Workspace-Slug": "renamed",
        },
      });
    };
    try {
      await apiRequest(method, "todos/1/");
      assert.deepEqual(calls, ["old-slug", "12"]);
      assert.deepEqual(lines, ["Workspace: renamed (#12)"]);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      selectWorkspace(undefined);
      delete process.env.TODOBUD_API_KEY;
    }
  });
}

test("project selections store IDs and unavailable selections never fall back", async () =>
  withProject(async (directory) => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      assert.equal(init?.method, "GET");
      assert.equal(
        (init?.headers as Record<string, string>)["X-Workspace"],
        "9",
      );
      return Response.json({ detail: "Not found" }, { status: 404 });
    };
    try {
      assert.equal((await workspaceSelection()).identifier, "personal");
      await saveWorkspace({
        id: 9,
        kind: "team",
        slug: "stored-team",
        name: "Stored",
      });
      assert.equal((await workspaceSelection()).identifier, "9");
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, ".todobud.json"), "utf8")),
        { server: "https://example.test", workspace: 9 },
      );
      await assert.rejects(
        () => apiRequest("POST", "todos/", { title: "No" }),
        /Workspace "9".*unavailable/,
      );
      assert.equal(requests, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));

test("personal works without setup and an integer is sent on the write", async () =>
  withProject(async () => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = async (_url, init) => {
      methods.push(init?.method || "");
      const headers = init?.headers as Record<string, string>;
      if (init?.method === "GET") {
        assert.equal(headers["X-Workspace"], undefined);
        return Response.json({ id: 3, kind: "personal", slug: null });
      }
      assert.equal(headers["X-Workspace"], "3");
      return Response.json(
        { id: 1 },
        { headers: { "X-Workspace-ID": "3", "X-Workspace-Kind": "personal" } },
      );
    };
    try {
      await apiRequest("POST", "todos/", { title: "Test" });
      assert.deepEqual(methods, ["GET", "POST"]);
    } finally {
      globalThis.fetch = originalFetch;
      selectWorkspace(undefined);
    }
  }));

test("selection precedence is flag, environment, exact-directory config, personal", async () =>
  withProject(async (directory) => {
    assert.equal((await workspaceSelection()).identifier, "personal");
    await saveWorkspace({ id: 9, kind: "team", slug: "team", name: "Team" });
    assert.equal((await workspaceSelection()).identifier, "9");
    process.env.TODOBUD_WORKSPACE = "environment-team";
    assert.equal((await workspaceSelection()).identifier, "environment-team");
    selectWorkspace("flag-team");
    assert.equal((await workspaceSelection()).identifier, "flag-team");
    await writeFile(join(directory, ".todobud.json"), "malformed");
    assert.equal((await workspaceSelection()).identifier, "flag-team");
    selectWorkspace(undefined);
    assert.equal((await workspaceSelection()).identifier, "environment-team");
    process.env.TODOBUD_WORKSPACE = "  ";
    await assert.rejects(workspaceSelection, /cannot be empty/);
    process.env.TODOBUD_WORKSPACE = "personal";
    selectWorkspace("");
    await assert.rejects(workspaceSelection, /cannot be empty/);
    selectWorkspace(undefined);
    delete process.env.TODOBUD_WORKSPACE;
    await assert.rejects(workspaceSelection, /Invalid .todobud.json/);
  }));

test("subdirectories do not inherit config, .env files, or global defaults", async () =>
  withProject(async (directory) => {
    await saveWorkspace({ id: 9, kind: "team", slug: "team", name: "Team" });
    const child = join(directory, "child");
    await mkdir(child);
    await writeFile(join(child, ".env"), "TODOBUD_WORKSPACE=team\n");
    const globalDirectory = join(directory, "global", "todobud");
    await mkdir(globalDirectory, { recursive: true });
    await writeFile(
      join(globalDirectory, "workspaces.json"),
      JSON.stringify({
        "https://example.test": {
          id: 9,
          kind: "team",
          slug: "team",
          name: "Team",
        },
      }),
    );
    process.env.XDG_CONFIG_HOME = join(directory, "global");
    process.chdir(child);
    assert.equal((await workspaceSelection()).identifier, "personal");
  }));

test("personal project config resolves the current account rather than storing its ID", async () =>
  withProject(async (directory) => {
    await saveWorkspace({
      id: 3,
      kind: "personal",
      slug: null,
      name: "Personal",
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, ".todobud.json"), "utf8")),
      {
        server: "https://example.test",
        workspace: "personal",
      },
    );
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    console.error = () => undefined;
    globalThis.fetch = async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      if (init?.method === "GET") {
        assert.equal(headers["X-Workspace"], undefined);
        return Response.json({
          id: 5,
          kind: "personal",
          slug: null,
          name: "Other account",
        });
      }
      assert.equal(headers["X-Workspace"], "5");
      return new Response(null, {
        status: 204,
        headers: { "X-Workspace-ID": "5", "X-Workspace-Kind": "personal" },
      });
    };
    try {
      await apiRequest("DELETE", "todos/1/");
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }
  }));

test("project config cannot silently switch servers or be overwritten on mismatch", async () =>
  withProject(async (directory) => {
    await saveWorkspace({ id: 9, kind: "team", slug: "team", name: "Team" });
    const original = await readFile(join(directory, ".todobud.json"), "utf8");
    process.env.TODOBUD_BASE_URL = "https://other.test";
    await assert.rejects(workspaceSelection, /server does not match/);
    await assert.rejects(
      () =>
        saveWorkspace({ id: 12, kind: "team", slug: "other", name: "Other" }),
      /server does not match/,
    );
    assert.equal(
      await readFile(join(directory, ".todobud.json"), "utf8"),
      original,
    );
    selectWorkspace("personal");
    assert.equal((await workspaceSelection()).identifier, "personal");
  }));

for (const workspace of [0, -1, 1.5, "9", "team", null]) {
  test(`invalid project workspace ${JSON.stringify(workspace)} never falls back`, async () =>
    withProject(async (directory) => {
      await writeFile(
        join(directory, ".todobud.json"),
        JSON.stringify({ server: "https://example.test", workspace }),
      );
      await assert.rejects(workspaceSelection, /Invalid .todobud.json/);
    }));
}

for (const headers of [
  {},
  { "X-Workspace-ID": "8", "X-Workspace-Kind": "personal" },
  { "X-Workspace-ID": "3", "X-Workspace-Kind": "team" },
]) {
  test(`unconfirmed writes are never repeated: ${JSON.stringify(headers)}`, async () =>
    withProject(async () => {
      const originalFetch = globalThis.fetch;
      let writes = 0;
      globalThis.fetch = async (_url, init) => {
        if (init?.method === "GET")
          return Response.json({ id: 3, kind: "personal", slug: null });
        writes++;
        return new Response(null, {
          status: 204,
          headers: headers as Record<string, string>,
        });
      };
      try {
        await assert.rejects(
          () => apiRequest("POST", "todos/", { title: "One" }),
          /write succeeded.*Verify it before retrying/,
        );
        assert.equal(writes, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }));
}
