import * as checkinChangeset from "./checkinChangeset";
import { BaseCmParser } from "../baseCmParser";
import { ICheckinChangeset } from "../../../models";

export class CheckinParser extends BaseCmParser<ICheckinChangeset[]> {
  public static readonly SEPARATOR: string = "@#@";
  private static readonly CHANGESET_LINE_START: string = "CHANGESET";
  private static readonly CHANGESET_SEPARATOR: string = ",";

  private static readonly InvalidCheckin: ICheckinChangeset = {
    changesetInfo: {
      changesetId: -1,
      repository: "invalid",
      server: "invalid",
    },
    mountPath: "invalid",
  };

  public parse(): Promise<ICheckinChangeset[]> {
    const result = this.mOutputBuffer.reduce<ICheckinChangeset[]>(
      (previous: ICheckinChangeset[], line: string) => {
        if (previous && previous.length) {
          return previous;
        }

        return this.parseLine(line);
      }, []);

    return Promise.resolve(result);
  }

  private parseLine(line: string): ICheckinChangeset[] {
    if (!line) {
      return [];
    }

    const params: string[] = line.trim().split(CheckinParser.SEPARATOR);
    if (!params || !params.length || params[0] !== CheckinParser.CHANGESET_LINE_START) {
      return [];
    }

    return params[1]
      .trim()
      .split(CheckinParser.CHANGESET_SEPARATOR)
      .reduce<ICheckinChangeset[]>((csets, checkinCsetSpec) => {
        const checkinCset: ICheckinChangeset | null = checkinChangeset.parse(checkinCsetSpec);
        return checkinCset ? csets.concat(checkinCset) : csets;
      }, [])
      .sort((x, y) => x.mountPath.localeCompare(y.mountPath));
  }
}
