import { ICmExecOptions, ICmResult, ICmShell } from "../shell";
import { OutputLinesParser } from "./outputLinesParser";

/**
 * Upper bound for commands that legitimately run for minutes (switch, update).
 * Not "no timeout": a cm that hangs would otherwise block the shell's queue forever.
 */
export const LONG_COMMAND_TIMEOUT_MILLIS = 2 * 60 * 60 * 1000;

/** A cm command that changes something: `command` and the args it takes, e.g. `branch` + `["create", ...]`. */
export interface IMutation {
  command: string;
  args: string[];
  /** Used in the fallback error text: `cm <name> failed.` */
  name: string;
  /** Only for commands that can run for minutes; see {@link ICmExecOptions.timeoutMillis}. */
  options?: ICmExecOptions;
}

/**
 * Runs a cm command that changes something and returns what it printed.
 *
 * Success is cm's exit code, as the shell reports it. Lines on standard error
 * after a successful run (progress, warnings) are returned with the rest
 * rather than thrown: nothing here has observed cm's output for these commands,
 * so nothing here depends on its wording.
 */
export async function runMutation(shell: ICmShell, mutation: IMutation): Promise<string[]> {
  const parser = new OutputLinesParser();
  const result: ICmResult<string[]> = mutation.options === undefined
    ? await shell.exec(mutation.command, mutation.args, parser)
    : await shell.exec(mutation.command, mutation.args, parser, mutation.options);

  if (!result.success) {
    throw result.error ?? new Error(`cm ${mutation.name} failed.`);
  }

  return result.result ?? [];
}
