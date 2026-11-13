import { expect } from "chai";
import { OutputLinesParser } from "../../../../../cm/commands/outputLinesParser";

describe("OutputLinesParser", () => {
  it("returns standard output then standard error, without blank lines", async () => {
    const parser = new OutputLinesParser();
    parser.readLineOut("Downloading 3 files");
    parser.readLineOut("   ");
    parser.readLineErr("Warning: something");
    parser.readLineOut("Done");

    expect(await parser.parse()).to.eql([ "Downloading 3 files", "Done", "Warning: something" ]);
  });

  it("returns nothing for silent output", async () => {
    expect(await new OutputLinesParser().parse()).to.eql([]);
  });

  it("still reports standard error as the error", () => {
    const parser = new OutputLinesParser();
    parser.readLineErr("boom");
    expect(parser.getError()?.message).to.equal("boom");
  });
});
