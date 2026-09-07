export function printValue(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      console.log("No results.");
      return;
    }
    const rows = value.map(displayRecord);
    console.table(rows);
    return;
  }
  if (value && typeof value === "object") {
    console.table([displayRecord(value as Record<string, unknown>)]);
    return;
  }
  if (value !== undefined) console.log(value);
}

function displayRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const preferred = [
    "id",
    "title",
    "status",
    "priority",
    "project",
    "todo",
    "kind",
    "message",
    "due_at",
    "updated_at",
  ];
  const keys = preferred.filter((key) => key in record);
  const selected = keys.length ? keys : Object.keys(record).slice(0, 8);
  return Object.fromEntries(
    selected.map((key) => {
      const value = record[key];
      return [
        key,
        typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : value,
      ];
    }),
  );
}
