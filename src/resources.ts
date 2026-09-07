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

function parseInteger(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return Number(value);
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseDueDate(value: string, flag = "--due-date"): string {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!isCalendarDate(year, month, day)) {
      throw new Error(`${flag} is not a real date.`);
    }
    return trimmed;
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    const year = Number(us[3]);
    if (!isCalendarDate(year, month, day)) {
      throw new Error(`${flag} is not a real date.`);
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  throw new Error(`${flag} must be YYYY-MM-DD or M/D/YYYY.`);
}

export interface ResourceField {
  flag: string;
  option: string;
  key: string;
  description: string;
  integer?: boolean;
  date?: boolean;
}

export function payloadFromOptions(
  options: Record<string, string | undefined>,
  fields: ResourceField[],
  title?: string,
): JsonObject {
  const payload: JsonObject = options.data ? parseData(options.data) : {};
  if (title) payload.title = title;
  for (const field of fields) {
    const value = options[field.flag];
    if (value === undefined) continue;
    if (field.integer) {
      payload[field.key] = parseInteger(value, `--${field.flag}`);
    } else if (field.date) {
      payload[field.key] = parseDueDate(value, `--${field.flag}`);
    } else {
      payload[field.key] = value;
    }
  }
  return payload;
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

function addFieldOptions(command: Command, fields: ResourceField[]): Command {
  for (const field of fields) {
    command.option(field.option, field.description);
  }
  command.option("--data <json>", "JSON object merged with the other flags");
  return command;
}

interface ResourceDefinition {
  command: string;
  singular: string;
  path: string;
  titleArgument?: boolean;
  fields?: ResourceField[];
  update?: boolean;
  delete?: boolean;
}

export function addResourceCommands(
  program: Command,
  definition: ResourceDefinition,
): void {
  const fields = definition.fields || [];
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

  const create = group
    .command("create")
    .description(`Create a ${definition.singular}`);
  if (definition.titleArgument) {
    create.argument("[title]", `${definition.singular} title`);
  }
  addFieldOptions(create, fields);
  const submitCreate = async (
    title: string | undefined,
    options: Record<string, string | undefined>,
    command: Command,
  ) => {
    const payload = payloadFromOptions(options, fields, title);
    if (definition.titleArgument && !payload.title) {
      throw new Error(
        `Provide a title, for example \`todobud ${definition.command} create "Ship it"\`.`,
      );
    }
    if (Object.keys(payload).length === 0) {
      throw new Error(
        `Provide fields to create, for example \`todobud ${definition.command} create --help\`.`,
      );
    }
    const value = await apiRequest<JsonObject>(
      "POST",
      `${definition.path}/`,
      payload,
    );
    printValue(value, jsonOutput(command));
  };
  if (definition.titleArgument) {
    create.action(
      async (
        title: string | undefined,
        options: Record<string, string | undefined>,
        command: Command,
      ) => submitCreate(title, options, command),
    );
  } else {
    create.action(
      async (options: Record<string, string | undefined>, command: Command) =>
        submitCreate(undefined, options, command),
    );
  }

  if (definition.update !== false) {
    addFieldOptions(
      group
        .command("update")
        .description(`Update a ${definition.singular}`)
        .argument("<id>", `${definition.singular} ID`),
      fields,
    ).action(
      async (
        id: string,
        options: Record<string, string | undefined>,
        command: Command,
      ) => {
        const payload = payloadFromOptions(options, fields);
        if (Object.keys(payload).length === 0) {
          throw new Error(
            `Provide a field to change, for example \`todobud ${definition.command} update ${id} --status D\`.`,
          );
        }
        const value = await apiRequest<JsonObject>(
          "PATCH",
          `${definition.path}/${encodeURIComponent(id)}/`,
          payload,
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
