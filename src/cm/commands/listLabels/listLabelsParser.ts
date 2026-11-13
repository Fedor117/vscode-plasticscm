import * as xml2js from "xml2js";
import {
  PLASTIC_QUERY_OPTIONS, readDate, readId, readQueryRows, readText,
} from "../findChangesets/findChangesetsParser";
import { BaseCmParser } from "../baseCmParser";
import { ILabelInfo } from "../../../models";

/** Parses `cm find label --xml`, whose rows cm prints as `<MARKER>`. */
export class ListLabelsParser extends BaseCmParser<ILabelInfo[]> {
  public async parse(): Promise<ILabelInfo[] | undefined> {
    try {
      const query: unknown = await xml2js.parseStringPromise(
        this.mOutputBuffer.join("\n"), PLASTIC_QUERY_OPTIONS);
      return readQueryRows<ILabelRow>(query, "marker").map(row => ({
        branch: readText(row.branch),
        changesetId: readId(row.changeset),
        comment: readText(row.comment),
        date: readDate(row.date),
        id: readId(row.id),
        name: readText(row.name),
        owner: readText(row.owner),
        repository: readText(row.repository),
        server: readText(row.repserver),
      }));
    } catch (error) {
      this.mParseError = error as Error;
      return undefined;
    }
  }
}

interface ILabelRow {
  branch?: unknown;
  changeset?: unknown;
  comment?: unknown;
  date?: unknown;
  id?: unknown;
  name?: unknown;
  owner?: unknown;
  repository?: unknown;
  repserver?: unknown;
}
