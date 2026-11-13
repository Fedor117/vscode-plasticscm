import { BaseCmParser } from "../baseCmParser";
import { ILockInfo } from "../../../models";

/** Separators passed to `cm lock list`; chosen so that no path, user or branch name is likely to contain them. */
export const LOCK_LINE_START = "@@";
export const LOCK_LINE_END = "##";
export const LOCK_FIELD_SEPARATOR = "~|~";

/** Fields of a `--smartlocks` line, in order. The last one (the path) may itself contain the separator. */
const FIELD_COUNT = 12;

function toNumber(text: string): number {
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : 0;
}

/** Reads one line of `cm lock list`, or undefined when it is not a lock line. */
export function parseLockLine(line: string): ILockInfo | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(LOCK_LINE_START) || !trimmed.endsWith(LOCK_LINE_END)) {
    return undefined;
  }

  const body = trimmed.substring(LOCK_LINE_START.length, trimmed.length - LOCK_LINE_END.length);
  const fields = body.split(LOCK_FIELD_SEPARATOR);
  if (fields.length < FIELD_COUNT) {
    return undefined;
  }

  return {
    date: fields[3],
    destinationBranch: fields[4],
    destinationRevisionId: toNumber(fields[5]),
    guid: fields[2],
    holderBranch: fields[6],
    holderRevisionId: toNumber(fields[7]),
    itemId: toNumber(fields[1]),
    owner: fields[9],
    path: fields.slice(FIELD_COUNT - 1).join(LOCK_FIELD_SEPARATOR),
    repository: fields[0],
    status: fields[8],
    workspace: fields[10],
  };
}

export class LocksParser extends BaseCmParser<ILockInfo[]> {
  public parse(): Promise<ILockInfo[] | undefined> {
    const lines = this.mOutputBuffer.filter(line => line.trim().length > 0);
    const locks: ILockInfo[] = [];

    for (const line of lines) {
      const lock = parseLockLine(line);
      if (lock) {
        locks.push(lock);
      }
    }

    if (lines.length > 0 && locks.length === 0) {
      this.mParseError = new Error(`cm lock list printed something this extension cannot read: ${lines[0]}`);
      return Promise.resolve(undefined);
    }

    return Promise.resolve(locks);
  }
}
