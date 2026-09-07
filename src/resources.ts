import { Command } from "commander";

import { apiRequest, listAll, type JsonObject } from "./api.js";
import { printValue } from "./output.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function parseData(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--data must be valid JSON.");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("--data must be a JSON object.");
  }
  return parsed as JsonObject;
}

function jsonOutput(command: Command): boolean {
  return Boolean(command.optsWithGlobals().json);
}

function buildListPath(
  path: string,
  options: { page?: string; pageSize?: string; filter: string[] },
): string {
  const query = new URLSearchParams();
  if (options.page) query.set("page", options.page);
  if (options.pageSize) query.set("page_size", options.pageSize);
  for (const filter of options.filter) {
    const separator = filter.indexOf("=");
    if (separator <= 0)
      throw new Error(`Invalid filter "${filter}"; use key=value.`);
    query.append(filter.slice(0, separator), filter.slice(separator + 1));
  }
  const suffix = query.toString();
  return `${path}/${suffix ? `?${suffix}` : ""}`;
}

interface ResourceDefinition {
  command: string;
  singular: string;
  path: string;
  update?: boolean;
  delete?: boolean;
}

export function addResourceCommands(
  program: Command,
  definition: ResourceDefinition,
): void {
  const group = program
    .command(definition.command)
    .description(`Manage TodoBud ${definition.command}`);

  group
    .command("list")
    .description(`List ${definition.command}`)
    .option("--page <number>", "Page number")
    .option("--page-size <number>", "Results per page (maximum 100)")
    .option(
      "-f, --filter <key=value>",
      "API filter; repeat as needed",
      collect,
      [],
    )
    .option("--all", "Follow pagination and return every result")
    .action(
      async (
        options: {
          page?: string;
          pageSize?: string;
          filter: string[];
          all?: boolean;
        },
        command: Command,
      ) => {
        const path = buildListPath(definition.path, options);
        if (options.all) {
          printValue(await listAll(path), jsonOutput(command));
        } else {
          const page = await apiRequest<JsonObject>("GET", path);
          printValue(page.results || page, jsonOutput(command));
        }
      },
    );

  group
    .command("get")
    .description(`Get one ${definition.singular}`)
    .argument("<id>", `${definition.singular} ID`)
    .action(async (id: string, _options: unknown, command: Command) => {
      const value = await apiRequest<JsonObject>(
        "GET",
        `${definition.path}/${encodeURIComponent(id)}/`,
      );
      printValue(value, jsonOutput(command));
    });

  group
    .command("create")
    .description(`Create a ${definition.singular}`)
    .requiredOption("--data <json>", "Resource fields as a JSON object")
    .action(async (options: { data: string }, command: Command) => {
      const value = await apiRequest<JsonObject>(
        "POST",
        `${definition.path}/`,
        parseData(options.data),
      );
      printValue(value, jsonOutput(command));
    });

  if (definition.update !== false) {
    group
      .command("update")
      .description(`Update a ${definition.singular}`)
      .argument("<id>", `${definition.singular} ID`)
      .requiredOption("--data <json>", "Fields to update as a JSON object")
      .action(
        async (id: string, options: { data: string }, command: Command) => {
          const value = await apiRequest<JsonObject>(
            "PATCH",
            `${definition.path}/${encodeURIComponent(id)}/`,
            parseData(options.data),
          );
          printValue(value, jsonOutput(command));
        },
      );
  }

  if (definition.delete !== false) {
    group
      .command("delete")
      .description(`Permanently delete a ${definition.singular}`)
      .argument("<id>", `${definition.singular} ID`)
      .requiredOption("--yes", "Confirm permanent deletion")
      .action(async (id: string) => {
        await apiRequest<void>(
          "DELETE",
          `${definition.path}/${encodeURIComponent(id)}/`,
        );
        console.log(`Deleted ${definition.singular} ${id}.`);
      });
  }
}
