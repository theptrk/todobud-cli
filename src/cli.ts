import { Command } from "commander";
import { apiRequest, resolveWorkspace } from "./api.js";
import { printValue } from "./output.js";
import { selectWorkspace, saveWorkspace, workspaceLabel } from "./workspace.js";

import {
  authStatus,
  loginWithBrowser,
  loginWithDevice,
  logout,
} from "./auth.js";
import { addResourceCommands } from "./resources.js";
import { currentVersion, reportUpdate } from "./update.js";

export function createProgram(): Command {
  const program = new Command()
    .name("todobud")
    .description("Manage TodoBud from your terminal")
    .version(currentVersion())
    .option("--json", "Print machine-readable JSON")
    .option("--workspace <id-or-slug>", "Workspace id, team slug, or personal")
    .hook("preAction", (_root, command) => {
      selectWorkspace(
        command.optsWithGlobals().workspace as string | undefined,
      );
    });

  const workspace = program
    .command("workspace")
    .description("Choose the workspace for API requests");
  workspace.command("list").action(async () =>
    printValue(
      await apiRequest("GET", "workspaces/", undefined, {
        skipDefault: true,
      }),
      Boolean(program.opts().json),
    ),
  );
  workspace
    .command("use <id-or-slug>")
    .requiredOption(
      "--here",
      "Save .todobud.json in the current directory only",
    )
    .action(async (identifier: string) => {
      const resolved = await resolveWorkspace(identifier);
      await saveWorkspace(resolved);
      if (program.opts().json) printValue(resolved, true);
      else
        console.log(
          `Directory workspace: ${workspaceLabel(resolved)} (.todobud.json)`,
        );
    });

  const auth = program.command("auth").description("Manage CLI authentication");
  auth
    .command("login")
    .description("Log in through TodoBud in your browser")
    .option("--device", "Use the device flow for SSH or headless environments")
    .option("--no-browser", "Print the authorization URL without opening it")
    .action(async (options: { device?: boolean; browser: boolean }) => {
      if (options.device) await loginWithDevice(options.browser);
      else await loginWithBrowser(options.browser);
    });
  auth
    .command("status")
    .description("Show the active authentication method")
    .action(authStatus);
  auth.command("logout").description("Revoke this CLI session").action(logout);

  addResourceCommands(program, {
    command: "todos",
    singular: "todo",
    path: "todos",
    titleArgument: true,
    fields: [
      {
        flag: "title",
        option: "--title <text>",
        key: "title",
        description: "Todo title",
      },
      {
        flag: "body",
        option: "--body <text>",
        key: "body",
        description: "Markdown notes; alias of --description",
      },
      {
        flag: "description",
        option: "--description <text>",
        key: "body",
        description: "Long description",
      },
      {
        flag: "status",
        option: "--status <code>",
        key: "status",
        description: "T, IP, D, or C",
      },
      {
        flag: "priority",
        option: "--priority <code>",
        key: "priority",
        description: "P0, P1, P2, or P3",
      },
      {
        flag: "project",
        option: "--project <id>",
        key: "project",
        description: "Project id",
        integer: true,
      },
      {
        flag: "due",
        option: "--due <date>",
        key: "due_at",
        description: "Alias of --due-date",
        date: true,
      },
      {
        flag: "dueDate",
        option: "--due-date <date>",
        key: "due_at",
        description: "Due date (M/D/YYYY or YYYY-MM-DD)",
        date: true,
      },
    ],
  });
  addResourceCommands(program, {
    command: "projects",
    singular: "project",
    path: "projects",
    titleArgument: true,
    fields: [
      {
        flag: "title",
        option: "--title <text>",
        key: "title",
        description: "Project title",
      },
      {
        flag: "body",
        option: "--body <text>",
        key: "body",
        description: "Markdown notes",
      },
      {
        flag: "status",
        option: "--status <code>",
        key: "status",
        description: "Project status",
      },
      {
        flag: "due",
        option: "--due <date>",
        key: "due_at",
        description: "Alias of --due-date",
        date: true,
      },
      {
        flag: "dueDate",
        option: "--due-date <date>",
        key: "due_at",
        description: "Due date (M/D/YYYY or YYYY-MM-DD)",
        date: true,
      },
    ],
  });
  addResourceCommands(program, {
    command: "notes",
    singular: "note",
    path: "notes",
    titleArgument: true,
    fields: [
      {
        flag: "title",
        option: "--title <text>",
        key: "title",
        description: "Note title",
      },
      {
        flag: "body",
        option: "--body <text>",
        key: "body",
        description: "Markdown source",
      },
      {
        flag: "todo",
        option: "--todo <id>",
        key: "todo",
        description: "Attach to a todo",
        integer: true,
      },
      {
        flag: "project",
        option: "--project <id>",
        key: "project",
        description: "Attach to a project",
        integer: true,
      },
    ],
  });
  addResourceCommands(program, {
    command: "activities",
    singular: "activity",
    path: "activities",
    update: false,
    delete: false,
    paginated: false,
    fields: [
      {
        flag: "todo",
        option: "--todo <id>",
        key: "todo",
        description: "Todo id",
        integer: true,
      },
      {
        flag: "kind",
        option: "--kind <kind>",
        key: "kind",
        description: "comment or link",
      },
      {
        flag: "message",
        option: "--message <text>",
        key: "message",
        description: "Comment text",
      },
      {
        flag: "url",
        option: "--url <url>",
        key: "url",
        description: "Link URL",
      },
    ],
  });

  program
    .command("update")
    .description("Check npm for a newer TodoBud CLI release")
    .action(async () => reportUpdate(true));

  return program;
}
