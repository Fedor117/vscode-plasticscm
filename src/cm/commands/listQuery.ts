import { ICmParser, ICmShell } from "../shell";
import { IListPage, IListQuery } from "../../models";
import { assertInteger } from "./findChangesets/findChangesets";

/** Validated `limit`/`offset` of a list query, with one extra row asked for to learn whether more exist. */
export function pageClause(query: IListQuery): string {
  const offset = query.offset ?? 0;
  assertPage(query);
  return offset > 0
    ? `limit ${query.limit + 1} offset ${offset}`
    : `limit ${query.limit + 1}`;
}

export function assertPage(query: IListQuery): void {
  assertInteger(query.limit, "limit");
  if (query.limit <= 0) {
    throw new Error(`limit must be positive, got ${query.limit}.`);
  }
  const offset = query.offset ?? 0;
  assertInteger(offset, "offset");
  if (offset < 0) {
    throw new Error(`offset must not be negative, got ${offset}.`);
  }
}

/** Cuts the extra row {@link pageClause} asked for. */
export function toPage<T>(rows: T[], limit: number): IListPage<T> {
  return { hasMore: rows.length > limit, items: rows.slice(0, limit) };
}

/** Runs one `cm find`, throwing what cm or the parser reported. */
export async function runFind<T>(
    shell: ICmShell,
    args: string[],
    parser: ICmParser<T[]>,
    objectType: string): Promise<T[]> {
  const result = await shell.exec("find", args, parser);

  if (!result.success) {
    throw result.error ?? new Error(`cm find ${objectType} failed.`);
  }

  if (result.error) {
    throw result.error;
  }

  return result.result ?? [];
}
