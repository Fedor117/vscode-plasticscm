import { assertCmArgument, assertFullBranchName } from "../refNames";
import { IMergeReport, MERGE_FIELD_SEPARATOR, parseConflictMarkerLines, parseMergeLines } from "./mergeParser";
import { ICmShell } from "../../shell";
import { LONG_COMMAND_TIMEOUT_MILLIS } from "../runMutation";
import { OutputLinesParser } from "../outputLinesParser";

/** A preview only reads, but the server compares two trees for it, which the default timeout may not cover. */
export const MERGE_PREVIEW_TIMEOUT_MILLIS = 10 * 60 * 1000;

/**
 * The two files cm keeps the answers to directory conflicts in, between the
 * calls that give them and the merge that uses them. cm creates both.
 */
export interface IMergeResolutionFiles {
  readonly resultFile: string;
  readonly solvedFile: string;
}

/** An answer to a directory conflict. cm accepts `rename` only for some kinds (an evil twin; not a change/delete). */
export type DirectoryResolution =
  | { readonly keep: "source" }
  | { readonly keep: "destination" }
  /** Keeps both items: the destination's is renamed to `name`, one path segment. */
  | { readonly keep: "both"; readonly name: string };

export interface IMergeRunOptions {
  /** The answers given to the directory conflicts of this merge. */
  readonly resolutions?: IMergeResolutionFiles;
  /**
   * For files changed on both branches that cm cannot merge as text (binary
   * files, symlinks): take the merged branch's or keep the workspace's. Without
   * it cm leaves them as they are and names them in `report.unresolved`.
   */
  readonly keep?: "source" | "destination";
}

/** How `cm merge --merge` ended. */
export interface IMergeResult {
  readonly report: IMergeReport;
  /** cm's exit code was 0: everything merged and nothing is left to resolve. */
  readonly succeeded: boolean;
  /** What cm printed when it did not succeed. */
  readonly error?: Error;
}

function resolutionArgs(files: IMergeResolutionFiles | undefined): string[] {
  if (!files) {
    return [];
  }
  assertCmArgument(files.resultFile, "merge result file");
  assertCmArgument(files.solvedFile, "solved conflicts file");
  return [ `--mergeresultfile=${files.resultFile}`, `--solvedconflictsfile=${files.solvedFile}` ];
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
   * With `resolutions`, the directory conflicts already answered are left out.
   */
  public static async preview(
      shell: ICmShell, sourceBranch: string, resolutions?: IMergeResolutionFiles): Promise<IMergeReport> {
    const parser = new OutputLinesParser();
    const result = await shell.exec(
      "merge",
      mergeArgs(sourceBranch, ...resolutionArgs(resolutions)),
      parser,
      { timeoutMillis: MERGE_PREVIEW_TIMEOUT_MILLIS });
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
   * `cm merge br:<branch> --resolveconflict --conflict=<index> --resolutionoption=src|dst|rename`:
   * records the answer to one directory conflict in `files`, the way cm's help
   * describes for plugins. Nothing in the workspace changes. `index` counts
   * from 1 among the conflicts not answered yet, and the report returned holds
   * the ones still open after this answer.
   */
  public static async resolveDirectoryConflict(
      shell: ICmShell,
      sourceBranch: string,
      index: number,
      resolution: DirectoryResolution,
      files: IMergeResolutionFiles): Promise<IMergeReport> {

    if (!Number.isInteger(index) || index < 1) {
      throw new Error(`'${index}' is not the number of a conflict.`);
    }
    const option = resolution.keep === "source" ? "src" : resolution.keep === "destination" ? "dst" : "rename";
    const args = [ "--resolveconflict", `--conflict=${index}`, `--resolutionoption=${option}` ];
    if (resolution.keep === "both") {
      assertCmArgument(resolution.name, "new name");
      if (/[/\\]/.test(resolution.name) || resolution.name.startsWith("-")) {
        throw new Error(`'${resolution.name}' cannot be used as a name: it contains a slash or starts with '-'.`);
      }
      args.push(`--resolutioninfo=${resolution.name}`);
    }

    const parser = new OutputLinesParser();
    const result = await shell.exec(
      "merge",
      mergeArgs(sourceBranch, ...args, ...resolutionArgs(files)),
      parser,
      { timeoutMillis: MERGE_PREVIEW_TIMEOUT_MILLIS });
    if (!result.success) {
      throw result.error ?? new Error("cm merge --resolveconflict failed.");
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
   * `succeeded: false` with the files in `report.unresolved`. Running it again
   * leaves the files that already have markers as they are.
   *
   * Rejects only when cm failed without touching the workspace.
   */
  public static async run(
      shell: ICmShell, sourceBranch: string, options: IMergeRunOptions = {}): Promise<IMergeResult> {
    const keep = options.keep === undefined ? [] : [options.keep === "source" ? "--keepsource" : "--keepdestination"];
    const parser = new OutputLinesParser();
    const result = await shell.exec(
      "merge",
      mergeArgs(
        sourceBranch,
        "--merge", "--conflict-markers", "--nointeractiveresolution", ...keep, ...resolutionArgs(options.resolutions)),
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

  /**
   * `cm merge --list-conflict-markers`: the server paths (`/src/a.txt`) of the
   * files a merge wrote conflict markers into that still contain them. cm
   * refuses a check-in while there are any. It exits 1 when it lists a file.
   */
  public static async conflictMarkers(shell: ICmShell): Promise<string[]> {
    const parser = new OutputLinesParser();
    const result = await shell.exec("merge", ["--list-conflict-markers"], parser);
    const paths = parseConflictMarkerLines(parser.getOutputLines());
    if (!result.success && paths.length === 0) {
      throw result.error ?? new Error("cm merge --list-conflict-markers failed.");
    }
    return paths;
  }

  /** `cm merge --mark-resolved <path>…`: stops treating marker text left in these files as a pending conflict. */
  public static async markResolved(shell: ICmShell, paths: string[]): Promise<void> {
    paths.forEach(path => assertCmArgument(path, "path"));
    const parser = new OutputLinesParser();
    const result = await shell.exec("merge", [ "--mark-resolved", ...paths ], parser);
    if (!result.success) {
      throw result.error ?? new Error("cm merge --mark-resolved failed.");
    }
  }
}
