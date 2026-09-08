import { ICmParser, ICmResult, ICmShell } from "../../shell";
import { assertInteger } from "../findChangesets/findChangesets";
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

    const parser: ICmParser<IChangesetFileChange[]> = new DiffChangesetParser();

    const result: ICmResult<IChangesetFileChange[]> = await shell.exec(
      "diff", [ `cs:${changesetId}`, DIFF_FORMAT, "--repositorypaths" ], parser);

    if (!result.success) {
      throw result.error ?? new Error(`cm diff cs:${changesetId} failed.`);
    }

    if (result.error) {
      throw result.error;
    }

    return result.result ?? [];
  }
}
