import * as xml2js from "xml2js";
import { PLASTIC_QUERY_OPTIONS, readId, readQueryRows, readText } from "../findChangesets/findChangesetsParser";
import { BaseCmParser } from "../baseCmParser";
import { IMergeLink } from "../../../models";

const BRANCH_SPEC_PREFIX = "br:";

/**
 * `cm find merge` prints branches as specs (`br:/main`) with spaces percent
 * encoded; the model keeps plain names. Only `%20` is undone, the exact inverse
 * of what the query side encodes: `decodeURIComponent` would mangle a branch
 * name that legitimately contains a `%`.
 */
function readBranchName(value: unknown): string {
  const spec = readText(value);
  const name = spec.startsWith(BRANCH_SPEC_PREFIX) ? spec.substring(BRANCH_SPEC_PREFIX.length) : spec;
  return name.split("%20").join(" ");
}

export class FindMergesParser extends BaseCmParser<IMergeLink[]> {
  public async parse(): Promise<IMergeLink[] | undefined> {
    try {
      const query: unknown = await xml2js.parseStringPromise(
        this.mOutputBuffer.join("\n"), PLASTIC_QUERY_OPTIONS);
      return readQueryRows<IMergeRow>(query, "merge").map(row => ({
        destinationBranch: readBranchName(row.dstbranch),
        destinationChangesetId: readId(row.dstchangeset),
        sourceBranch: readBranchName(row.srcbranch),
        sourceChangesetId: readId(row.srcchangeset),
        type: readText(row.type),
      }));
    } catch (error) {
      this.mParseError = error as Error;
      return undefined;
    }
  }
}

interface IMergeRow {
  dstbranch?: unknown;
  dstchangeset?: unknown;
  srcbranch?: unknown;
  srcchangeset?: unknown;
  type?: unknown;
}
