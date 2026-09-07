import { Command } from "commander";

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
    .option("--json", "Print machine-readable JSON");

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
  });
  addResourceCommands(program, {
    command: "projects",
    singular: "project",
    path: "projects",
  });
  addResourceCommands(program, {
    command: "notes",
    singular: "note",
    path: "notes",
  });
  addResourceCommands(program, {
    command: "activities",
    singular: "activity",
    path: "activities",
    update: false,
    delete: false,
  });

  program
    .command("update")
    .description("Check npm for a newer TodoBud CLI release")
    .action(async () => reportUpdate(true));

  return program;
}
