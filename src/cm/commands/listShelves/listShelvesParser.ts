import * as xml2js from "xml2js";
import {
  PLASTIC_QUERY_OPTIONS, readDate, readId, readQueryRows, readText,
} from "../findChangesets/findChangesetsParser";
import { BaseCmParser } from "../baseCmParser";
import { IShelveInfo } from "../../../models";

export class ListShelvesParser extends BaseCmParser<IShelveInfo[]> {
  public async parse(): Promise<IShelveInfo[] | undefined> {
    try {
      const query: unknown = await xml2js.parseStringPromise(
        this.mOutputBuffer.join("\n"), PLASTIC_QUERY_OPTIONS);
      return readQueryRows<IShelveRow>(query, "shelve").map(row => ({
        comment: readText(row.comment),
        date: readDate(row.date),
        guid: readText(row.guid),
        id: readId(row.id),
        owner: readText(row.owner),
        parentChangesetId: readId(row.parent),
        repository: readText(row.repository),
        server: readText(row.repserver),
        shelveId: readId(row.shelveid),
      }));
    } catch (error) {
      this.mParseError = error as Error;
      return undefined;
    }
  }
}

interface IShelveRow {
  comment?: unknown;
  date?: unknown;
  guid?: unknown;
  id?: unknown;
  owner?: unknown;
  parent?: unknown;
  repository?: unknown;
  repserver?: unknown;
  shelveid?: unknown;
}
