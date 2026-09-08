import * as xml2js from "xml2js";
import {
  PLASTIC_QUERY_OPTIONS, readDate, readId, readQueryRows, readText,
} from "../findChangesets/findChangesetsParser";
import { BaseCmParser } from "../baseCmParser";
import { IBranchInfo } from "../../../models";

export class FindBranchParser extends BaseCmParser<IBranchInfo[]> {
  public async parse(): Promise<IBranchInfo[] | undefined> {
    try {
      const query: unknown = await xml2js.parseStringPromise(
        this.mOutputBuffer.join("\n"), PLASTIC_QUERY_OPTIONS);
      return readQueryRows<IBranchRow>(query, "branch").map(row => {
        const parent = readText(row.parent);
        return {
          comment: readText(row.comment),
          date: readDate(row.date),
          guid: readText(row.guid),
          headChangesetId: readId(row.changeset),
          name: readText(row.name),
          owner: readText(row.owner),
          // `/main` reports an empty <PARENT>, which is "no parent" rather than a branch named "".
          parent: parent === "" ? undefined : parent,
          repository: readText(row.repository),
          server: readText(row.repserver),
        };
      });
    } catch (error) {
      this.mParseError = error as Error;
      return undefined;
    }
  }
}

interface IBranchRow {
  changeset?: unknown;
  comment?: unknown;
  date?: unknown;
  guid?: unknown;
  name?: unknown;
  owner?: unknown;
  parent?: unknown;
  repository?: unknown;
  repserver?: unknown;
}
