import { expect } from "chai";
import { FindBranchParser } from "../../../../../cm/commands/findBranch/findBranchParser";
import { IBranchInfo } from "../../../../../models";

const XML_HEADER = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>";

const SAMPLE_BRANCH: string[] = [
  "  <BRANCH>",
  "    <ID>12121</ID>",
  "    <COMMENT></COMMENT>",
  "    <DATE>2026-08-31T12:59:54+01:00</DATE>",
  "    <OWNER>j.smith@partner.example.com</OWNER>",
  "    <NAME>/main/PartnerDemo</NAME>",
  "    <PARENT>/main</PARENT>",
  "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
  "    <REPNAME>Nimbus/Nimbus</REPNAME>",
  "    <REPSERVER>acme-studio@unity</REPSERVER>",
  "    <TYPE>T</TYPE>",
  "    <CHANGESET>3571</CHANGESET>",
  "    <GUID>b2a4c6d8-0e1f-4a3b-8c5d-6e7f8a9b0c1d</GUID>",
  "  </BRANCH>",
];

const MAIN_BRANCH: string[] = [
  "  <BRANCH>",
  "    <ID>3</ID>",
  "    <COMMENT>Trunk &amp; release line</COMMENT>",
  "    <DATE>2019-01-01T00:00:00+00:00</DATE>",
  "    <OWNER>admin</OWNER>",
  "    <NAME>/main</NAME>",
  "    <PARENT></PARENT>",
  "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
  "    <REPNAME>Nimbus/Nimbus</REPNAME>",
  "    <REPSERVER>acme-studio@unity</REPSERVER>",
  "    <TYPE>T</TYPE>",
  "    <CHANGESET>3622</CHANGESET>",
  "    <GUID>11111111-1111-1111-1111-111111111111</GUID>",
  "  </BRANCH>",
];

function wrap(...rows: string[][]): string[] {
  return [
    XML_HEADER, "<PLASTICQUERY>", ...rows.reduce<string[]>((all, row) => all.concat(row), []), "</PLASTICQUERY>",
  ];
}

interface IParseOutcome {
  error: Error | undefined;
  outputLines: string[];
  result: IBranchInfo[] | undefined;
}

async function parseLines(stdout: string[]): Promise<IParseOutcome> {
  const parser = new FindBranchParser();
  stdout.forEach(line => parser.readLineOut(line));
  // parse() sets the parse error, so it has to run before getError() is read.
  const result = await parser.parse();
  return {
    error: parser.getError(),
    outputLines: parser.getOutputLines(),
    result,
  };
}

describe("FindBranch Parser", () => {
  context("When there is no input", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([]);
    });

    it("produces an empty list without error", () => {
      expect(outcome.result).to.eql([]);
      expect(outcome.error).to.be.undefined;
    });
  });

  context("When the query matches nothing", () => {
    const stdout = [ XML_HEADER, "<PLASTICQUERY>", "</PLASTICQUERY>" ];
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(stdout);
    });

    it("produces an empty list", () => {
      expect(outcome.result).to.eql([]);
    });

    it("holds the output correctly", () => {
      expect(outcome.outputLines).to.eql(stdout);
    });

    it("doesn't produce any error", () => {
      expect(outcome.error).to.be.undefined;
    });
  });

  context("When the query matches a child branch", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(SAMPLE_BRANCH));
    });

    it("normalizes the single row into a list", () => {
      expect(outcome.result).to.have.lengthOf(1);
    });

    it("reads every field", () => {
      expect(outcome.result![0]).to.eql({
        comment: "",
        date: new Date("2026-08-31T12:59:54+01:00"),
        guid: "b2a4c6d8-0e1f-4a3b-8c5d-6e7f8a9b0c1d",
        headChangesetId: 3571,
        name: "/main/PartnerDemo",
        owner: "j.smith@partner.example.com",
        parent: "/main",
        repository: "Nimbus/Nimbus",
        server: "acme-studio@unity",
      });
    });

    it("reads the head changeset as a number", () => {
      expect(outcome.result![0].headChangesetId).to.be.a("number");
    });

    it("doesn't produce any error", () => {
      expect(outcome.error).to.be.undefined;
    });
  });

  context("When the query matches the root branch", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(MAIN_BRANCH));
    });

    it("reads an empty parent as undefined", () => {
      expect(outcome.result![0].parent).to.be.undefined;
    });

    it("decodes entities in the comment", () => {
      expect(outcome.result![0].comment).to.equal("Trunk & release line");
    });
  });

  context("When the query matches several branches", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(SAMPLE_BRANCH, MAIN_BRANCH));
    });

    it("keeps cm's order", () => {
      expect(outcome.result!.map(b => b.name)).to.eql([ "/main/PartnerDemo", "/main" ]);
    });

    it("reads each head changeset", () => {
      expect(outcome.result!.map(b => b.headChangesetId)).to.eql([ 3571, 3622 ]);
    });
  });

  context("When the head changeset or date is unreadable", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap([
        "  <BRANCH>",
        "    <NAME>/main/broken</NAME>",
        "    <PARENT>/main</PARENT>",
        "    <DATE>yesterday</DATE>",
        "    <CHANGESET></CHANGESET>",
        "  </BRANCH>",
      ]));
    });

    it("reads the head changeset as -1", () => {
      expect(outcome.result![0].headChangesetId).to.equal(-1);
    });

    it("falls back to the epoch", () => {
      expect(outcome.result![0].date.getTime()).to.equal(0);
    });
  });

  context("When the XML is malformed", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([ XML_HEADER, "<PLASTICQUERY>", "<BRANCH>", "</PLASTICQUERY>" ]);
    });

    it("produces an undefined result and an error", () => {
      expect(outcome.result).to.be.undefined;
      expect(outcome.error).to.be.not.undefined;
    });
  });
});
