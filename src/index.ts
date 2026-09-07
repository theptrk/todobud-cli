#!/usr/bin/env node

import { redact } from "./api.js";
import { createProgram } from "./cli.js";
import { automaticUpdateCheck } from "./update.js";

try {
  await createProgram().parseAsync(process.argv);
  await automaticUpdateCheck();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${redact(message)}`);
  process.exitCode = 1;
}
