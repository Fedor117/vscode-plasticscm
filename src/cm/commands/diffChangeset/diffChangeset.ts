import { assertBranchName, assertInteger } from "../findChangesets/findChangesets";
import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { DiffChangesetParser } from "./diffChangesetParser";
import { IChangesetFileChange } from "../../../models";

/**
 * One field per line because `{path}` may contain any separator character; the
 * parser resynchronises on `S:`. Never add `--added`/`--changed`/... filters:
 * they blank `{status}`.
 */
const DIFF_FORMAT = "--format=" + [
  "S:{status}",
  "T:{type}",
  "P:{path}",
  "R:{revid}",
  "PR:{parentrevid}",
  "B:{baserevid}",
  "SP:{srccmpath}",
  "DP:{dstcmpath}",
  "RP:{repository}",
].join("{newline}");

export class DiffChangeset {
  public static async run(shell: ICmShell, changesetId: number): Promise<IChangesetFileChange[]> {
    assertInteger(changesetId, "changesetId");
    return DiffChangeset.diff(shell, `cs:${changesetId}`);
  }

  /**
   * What a shelve changes against the changeset it was made on (`cm diff sh:N`
   * with one spec diffs against the parent, same as for a changeset). The
   * revision ids are real, so they open like a changeset's.
   */
  public static async runShelve(shell: ICmShell, shelveId: number): Promise<IChangesetFileChange[]> {
    assertInteger(shelveId, "shelveId");
    return DiffChangeset.diff(shell, `sh:${shelveId}`);
  }

  /**
   * What changed between two changesets (`cm diff cs:A cs:B`). The revision ids
   * are the ones in `toId`; the base ids are the file's revisions in `fromId`, so
   * the left side of a diff is "as of `fromId`".
   */
  public static async runBetween(shell: ICmShell, fromId: number, toId: number): Promise<IChangesetFileChange[]> {
    assertInteger(fromId, "fromId");
    assertInteger(toId, "toId");
    return DiffChangeset.diff(shell, `cs:${fromId}`, [`cs:${toId}`]);
  }

  /**
   * What a branch changed against its parent (`cm diff br:X`). `clean` leaves out
   * what the branch only merged in; it needs a plain branch spec.
   */
  public static async runBranch(
      shell: ICmShell, branchName: string, options: { clean?: boolean } = {}): Promise<IChangesetFileChange[]> {
    assertBranchName(branchName);
    return DiffChangeset.runSpec(shell, `br:${branchName}`, options);
  }

  /**
   * The one place a `br:` or `cs:` spec is diffed, for the Graph, the compare
   * commands and the reviews. `--clean` lists only files touched by plain
   * (non-merge) checkins, with the same revisions as the plain diff; it only
   * means something for a branch. Its "Calculating merges…" progress lines have
   * no field prefix and are skipped by the parser.
   */
  public static runSpec(
      shell: ICmShell, spec: string, options: { clean?: boolean } = {}): Promise<IChangesetFileChange[]> {
    if (!/^(br:.+|cs:\d+)$/.test(spec) || /[\r\n"\0]/.test(spec)) {
      return Promise.reject(new Error("Invalid comparison."));
    }
    if (options.clean && !spec.startsWith("br:")) {
      return Promise.reject(new Error("Only branch comparisons can leave out merged changes."));
    }
    return DiffChangeset.diff(shell, spec, [], options.clean ? ["--clean"] : []);
  }

  private static async diff(
      shell: ICmShell, spec: string, moreSpecs: string[] = [], flags: string[] = []): Promise<IChangesetFileChange[]> {
    const parser: ICmParser<IChangesetFileChange[]> = new DiffChangesetParser();

    const result: ICmResult<IChangesetFileChange[]> = await shell.exec(
      "diff", [ spec, ...moreSpecs, DIFF_FORMAT, "--repositorypaths", ...flags ], parser);

    if (!result.success) {
      throw result.error ?? new Error(`cm diff ${spec} failed.`);
    }

    if (result.error) {
      throw result.error;
    }

    return result.result ?? [];
  }
}
