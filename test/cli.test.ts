import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
    });
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
    assert.equal(request.url, "/api/v1/todos/");
    assert.equal(request.method, "POST");
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
  } finally {
    server.close();
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
