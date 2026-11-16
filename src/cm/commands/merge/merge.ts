import { IMergeReport, MERGE_FIELD_SEPARATOR, parseMergeLines } from "./mergeParser";
import { assertFullBranchName } from "../refNames";
import { ICmShell } from "../../shell";
import { LONG_COMMAND_TIMEOUT_MILLIS } from "../runMutation";
import { OutputLinesParser } from "../outputLinesParser";

/** A preview only reads, but the server compares two trees for it, which the default timeout may not cover. */
export const MERGE_PREVIEW_TIMEOUT_MILLIS = 10 * 60 * 1000;

/** How `cm merge --merge` ended. */
export interface IMergeResult {
  readonly report: IMergeReport;
  /** cm's exit code was 0: everything merged and nothing is left to resolve. */
  readonly succeeded: boolean;
  /** What cm printed when it did not succeed. */
  readonly error?: Error;
}

function mergeArgs(sourceBranch: string, ...options: string[]): string[] {
  assertFullBranchName(sourceBranch);
  return [ `br:${sourceBranch}`, ...options, "--machinereadable", `--fieldseparator=${MERGE_FIELD_SEPARATOR}` ];
}

/**
 * `cm merge br:<branch>`: merges a branch into what the workspace has loaded.
 * The workspace is the destination, so the shell's workspace decides where the merge goes.
 */
export class Merge {
  /**
   * `cm merge br:<branch> --machinereadable`: what the merge would do. Nothing changes.
   * A file listed as changed on both branches may still merge cleanly; cm only finds out by merging.
   */
  public static async preview(shell: ICmShell, sourceBranch: string): Promise<IMergeReport> {
    const parser = new OutputLinesParser();
    const result = await shell.exec(
      "merge", mergeArgs(sourceBranch), parser, { timeoutMillis: MERGE_PREVIEW_TIMEOUT_MILLIS });
    if (!result.success) {
      // With --machinereadable cm 11.0.16 exits 1 and prints nothing when the workspace has pending changes.
      throw parser.getOutputLines().some(line => line.trim().length > 0)
        ? result.error ?? new Error("cm merge failed.")
        : new Error(
          "cm merge refused without saying why. It does this when the workspace has pending changes: " +
          "check them in, shelve them or undo them, then merge again.");
    }
    return parseMergeLines(result.result ?? []);
  }

  /**
   * `cm merge br:<branch> --merge --conflict-markers --nointeractiveresolution --machinereadable`.
   *
   * The result stays in the workspace as pending changes with a pending merge
   * link; nothing is checked in. Without `--conflict-markers` cm opens its
   * merge tool for a file whose changes overlap and waits for it, which hangs
   * `cm shell` (seen with cm 11.0.16, also with `--nointeractiveresolution`
   * alone). With it cm launches nothing: it writes markers into such a file,
   * names it in the output and exits 1, which is reported here as
   * `succeeded: false` with the files in `report.unresolved`.
   *
   * Rejects only when cm failed without touching the workspace.
   */
  public static async run(shell: ICmShell, sourceBranch: string): Promise<IMergeResult> {
    const parser = new OutputLinesParser();
    const result = await shell.exec(
      "merge",
      mergeArgs(sourceBranch, "--merge", "--conflict-markers", "--nointeractiveresolution"),
      parser,
      { timeoutMillis: LONG_COMMAND_TIMEOUT_MILLIS });

    // A failed exec never reaches parser.parse(), so the lines are read from the parser itself.
    const report = parseMergeLines(parser.getOutputLines());
    if (result.success) {
      return { report, succeeded: true };
    }

    const error = result.error ?? new Error("cm merge failed.");
    if (report.applied === 0 && report.unresolved.length === 0) {
      throw error;
    }
    return { error, report, succeeded: false };
  }
}
