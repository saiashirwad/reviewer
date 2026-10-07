import type * as cf from "@cloudflare/workers-types";
import { DatabaseSync } from "node:sqlite";

/** Just enough of a Durable Object's SqlStorage over node:sqlite for local runs and tests. */
export const make = (path = ":memory:"): cf.SqlStorage => {
  const db = new DatabaseSync(path);
  const exec = (query: string, ...bindings: Array<unknown>) => {
    const statement = db.prepare(query);
    const rows = statement.columns().length > 0 ? statement.all(...(bindings as [])) : [];
    if (statement.columns().length === 0) statement.run(...(bindings as []));
    return { toArray: () => rows, one: () => rows[0] };
  };
  return { exec } as unknown as cf.SqlStorage;
};
