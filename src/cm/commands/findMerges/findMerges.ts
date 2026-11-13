import { assertBranchName, assertInteger, FIND_XML_ARGS } from "../findChangesets/findChangesets";
import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { FindMergesParser } from "./findMergesParser";
import { IMergeLink } from "../../../models";

/**
 * cm stores merge branch *specs* percent-encoded and matches them literally, so
 * `br:/main/my branch` finds nothing while `br:/main/my%20branch` finds the
 * merges. Only spaces appear encoded in the specs cm writes, and the query
 * side does no decoding, so the transform has to be this
 * narrow. `encodeURIComponent` cannot be used: it escapes the path separator,
 * and `br:%2Fmain` matches nothing. `where branch=` and `where name=` are
 * plain-name fields, which take the raw text instead.
 */
export function encodeBranchSpec(branchName: string): string {
  return branchName.split(" ").join("%20");
}

export class FindMerges {
  /**
   * Every merge link of the repository whose destination is in
   * `[fromChangesetId, beforeChangesetId)`, whatever the branches: what a graph of
   * all branches needs for one page of changesets.
   */
  public static async runRange(
      shell: ICmShell, fromChangesetId: number, beforeChangesetId?: number): Promise<IMergeLink[]> {
    assertInteger(fromChangesetId, "fromChangesetId");
    let where = `where dstchangeset >= ${fromChangesetId}`;
    if (beforeChangesetId !== undefined) {
      assertInteger(beforeChangesetId, "beforeChangesetId");
      where += ` and dstchangeset < ${beforeChangesetId}`;
    }

    const parser: ICmParser<IMergeLink[]> = new FindMergesParser();
    const result: ICmResult<IMergeLink[]> = await shell.exec(
      "find", [ "merge", where, ...FIND_XML_ARGS ], parser);

    if (!result.success) {
      throw result.error ?? new Error("cm find merge failed.");
    }

    if (result.error) {
      throw result.error;
    }

    return result.result ?? [];
  }

  public static async run(
      shell: ICmShell, branchName: string, fromChangesetId: number): Promise<IMergeLink[]> {
    assertBranchName(branchName);
    assertInteger(fromChangesetId, "fromChangesetId");

    const parser: ICmParser<IMergeLink[]> = new FindMergesParser();
    const spec = `br:${encodeBranchSpec(branchName)}`;
    // The destination is always the newer changeset, so bounding it bounds the whole link set.
    const where = `where (dstbranch='${spec}' or srcbranch='${spec}') and dstchangeset >= ${fromChangesetId}`;

    const result: ICmResult<IMergeLink[]> = await shell.exec(
      "find", [ "merge", where, ...FIND_XML_ARGS ], parser);

    if (!result.success) {
      throw result.error ?? new Error("cm find merge failed.");
    }

    if (result.error) {
      throw result.error;
    }

    return result.result ?? [];
  }
}
