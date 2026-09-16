import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = repositoryRoot,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/index.js", import.meta.url)), ...args],
      {
        cwd,
        env: { ...process.env, TODOBUD_WORKSPACE: undefined, ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("compiled CLI creates a todo from a title and flags", async () => {
  let created: unknown;
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/workspaces/current/") {
      assert.equal(request.headers["x-workspace"], "team");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ id: 7, kind: "team", slug: "team", name: "Team" }),
      );
      return;
    }
    assert.equal(request.url, "/api/v1/todos/");
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-workspace"], "7");
    response.setHeader("X-Workspace-ID", "7");
    response.setHeader("X-Workspace-Kind", "team");
    response.setHeader("X-Workspace-Slug", "team");
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      created = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 9, ...(created as object) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runCli(
      [
        "--json",
        "--workspace",
        "team",
        "todos",
        "create",
        "Ship it",
        "--status",
        "IP",
        "--project",
        "5",
      ],
      {
        TODOBUD_API_KEY: "integration-key",
        TODOBUD_BASE_URL: `http://127.0.0.1:${address.port}`,
        TODOBUD_DISABLE_UPDATE_CHECK: "1",
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(created, { title: "Ship it", status: "IP", project: 5 });
    assert.equal(JSON.parse(result.stdout).id, 9);
    assert.match(result.stderr, /Workspace: team \(#7\)/);
  } finally {
    server.close();
  }
});

test("compiled CLI saves only explicit directory config and defaults a subdirectory to personal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "todobud-cli-project-"));
  let writes = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/workspaces/current/") {
      const selected = request.headers["x-workspace"];
      assert.ok(
        selected === "team" || selected === "7" || selected === undefined,
      );
      response.end(
        JSON.stringify(
          selected === undefined
            ? { id: 3, kind: "personal", slug: null, name: "Personal" }
            : { id: 7, kind: "team", slug: "team", name: "Team" },
        ),
      );
      return;
    }
    assert.equal(request.url, "/api/v1/todos/");
    assert.equal(request.method, "POST");
    const id = request.headers["x-workspace"];
    assert.ok(id === "3" || id === "7");
    writes++;
    response.setHeader("X-Workspace-ID", id);
    response.setHeader("X-Workspace-Kind", id === "3" ? "personal" : "team");
    response.setHeader("X-Workspace-Slug", id === "3" ? "" : "team");
    request.resume();
    request.on("end", () =>
      response.end(JSON.stringify({ id: writes, title: "Task" })),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = {
    TODOBUD_API_KEY: "integration-key",
    TODOBUD_BASE_URL: `http://127.0.0.1:${address.port}`,
    TODOBUD_DISABLE_UPDATE_CHECK: "1",
  };
  try {
    const missingHere = await runCli(
      ["workspace", "use", "team"],
      env,
      directory,
    );
    assert.notEqual(missingHere.code, 0);
    assert.match(missingHere.stderr, /--here/);
    await assert.rejects(readFile(join(directory, ".todobud.json")), {
      code: "ENOENT",
    });
    const selected = await runCli(
      ["--json", "workspace", "use", "team", "--here"],
      env,
      directory,
    );
    assert.equal(selected.code, 0, selected.stderr);
    assert.equal(JSON.parse(selected.stdout).id, 7);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, ".todobud.json"), "utf8")),
      {
        server: env.TODOBUD_BASE_URL,
        workspace: 7,
      },
    );
    const team = await runCli(
      ["--json", "todos", "create", "Task"],
      env,
      directory,
    );
    assert.equal(team.code, 0, team.stderr);
    assert.equal(JSON.parse(team.stdout).id, 1);
    assert.match(team.stderr, /Workspace: team \(#7\)/);
    const child = join(directory, "child");
    await mkdir(child);
    const personal = await runCli(
      ["--json", "todos", "create", "Task"],
      env,
      child,
    );
    assert.equal(personal.code, 0, personal.stderr);
    assert.equal(JSON.parse(personal.stdout).id, 2);
    assert.match(personal.stderr, /Workspace: personal \(#3\)/);
    assert.equal(writes, 2);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiled CLI lists resources against a mocked TodoBud API", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/v1/todos/");
    assert.equal(request.headers.authorization, "Api-Key integration-key");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [{ id: 64, title: "Ship CLI", status: "IP" }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await runCli(["--json", "todos", "list"], {
      TODOBUD_API_KEY: "integration-key",
      TODOBUD_BASE_URL: `http://127.0.0.1:${address.port}`,
      TODOBUD_DISABLE_UPDATE_CHECK: "1",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { id: 64, title: "Ship CLI", status: "IP" },
    ]);
  } finally {
    server.close();
  }
});
