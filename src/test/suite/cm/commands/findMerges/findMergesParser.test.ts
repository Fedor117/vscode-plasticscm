import { expect } from "chai";
import { FindMergesParser } from "../../../../../cm/commands/findMerges/findMergesParser";
import { IMergeLink } from "../../../../../models";

const XML_HEADER = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>";

function merge(fields: { [tag: string]: string }): string[] {
  return [
    "  <MERGE>",
    ...Object.keys(fields).map(tag => `    <${tag}>${fields[tag]}</${tag}>`),
    "    <BASECHANGESET></BASECHANGESET>",
    "    <BASEBRANCH></BASEBRANCH>",
    "    <BASE></BASE>",
    "  </MERGE>",
  ];
}

const MERGE_INTO_CHILD = merge({
  DATE: "2026-09-01T10:00:00+01:00",
  DST: "br:/main/PartnerDemo@3351",
  DSTBRANCH: "br:/main/PartnerDemo",
  DSTCHANGESET: "3351",
  OWNER: "someone@example.com",
  SRC: "br:/main@3331",
  SRCBRANCH: "br:/main",
  SRCCHANGESET: "3331",
  TYPE: "merge",
});

const CHERRY_PICK_INTO_MAIN = merge({
  DATE: "2026-09-02T10:00:00+01:00",
  DST: "br:/main@3401",
  DSTBRANCH: "br:/main",
  DSTCHANGESET: "3401",
  OWNER: "someone@example.com",
  SRC: "br:/main/PartnerDemo@3371",
  SRCBRANCH: "br:/main/PartnerDemo",
  SRCCHANGESET: "3371",
  TYPE: "cherrypick",
});

const SUBTRACTIVE_SAME_BRANCH = merge({
  DSTBRANCH: "br:/main",
  DSTCHANGESET: "3441",
  SRCBRANCH: "br:/main",
  SRCCHANGESET: "3421",
  TYPE: "cherrypicksubtractive",
});

function wrap(...rows: string[][]): string[] {
  return [
    XML_HEADER, "<PLASTICQUERY>", ...rows.reduce<string[]>((all, row) => all.concat(row), []), "</PLASTICQUERY>",
  ];
}

interface IParseOutcome {
  error: Error | undefined;
  outputLines: string[];
  result: IMergeLink[] | undefined;
}

async function parseLines(stdout: string[]): Promise<IParseOutcome> {
  const parser = new FindMergesParser();
  stdout.forEach(line => parser.readLineOut(line));
  // parse() sets the parse error, so it has to run before getError() is read.
  const result = await parser.parse();
  return {
    error: parser.getError(),
    outputLines: parser.getOutputLines(),
    result,
  };
}

describe("FindMerges Parser", () => {
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

  context("When the query matches one merge", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(MERGE_INTO_CHILD));
    });

    it("normalizes the single row into a list", () => {
      expect(outcome.result).to.have.lengthOf(1);
    });

    it("strips the br: prefix and converts the ids", () => {
      expect(outcome.result![0]).to.eql({
        destinationBranch: "/main/PartnerDemo",
        destinationChangesetId: 3351,
        sourceBranch: "/main",
        sourceChangesetId: 3331,
        type: "merge",
      });
    });

    it("doesn't produce any error", () => {
      expect(outcome.error).to.be.undefined;
    });
  });

  context("When the query matches several merges", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(MERGE_INTO_CHILD, CHERRY_PICK_INTO_MAIN, SUBTRACTIVE_SAME_BRANCH));
    });

    it("keeps cm's order", () => {
      expect(outcome.result!.map(m => m.destinationChangesetId)).to.eql([ 3351, 3401, 3441 ]);
    });

    it("passes the type through untouched", () => {
      expect(outcome.result!.map(m => m.type)).to.eql([ "merge", "cherrypick", "cherrypicksubtractive" ]);
    });

    it("reads a link in the other direction", () => {
      expect(outcome.result![1]).to.eql({
        destinationBranch: "/main",
        destinationChangesetId: 3401,
        sourceBranch: "/main/PartnerDemo",
        sourceChangesetId: 3371,
        type: "cherrypick",
      });
    });

    it("keeps a same-branch link", () => {
      expect(outcome.result![2].sourceBranch).to.equal("/main");
      expect(outcome.result![2].destinationBranch).to.equal("/main");
    });
  });

  context("When branch fields lack the br: prefix", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(merge({
        DSTBRANCH: "/main/other",
        DSTCHANGESET: "20",
        SRCBRANCH: "/main",
        SRCCHANGESET: "10",
        TYPE: "merge",
      })));
    });

    it("leaves them untouched", () => {
      expect(outcome.result![0].sourceBranch).to.equal("/main");
      expect(outcome.result![0].destinationBranch).to.equal("/main/other");
    });
  });

  context("When a branch spec carries an encoded space", () => {
    let outcome: IParseOutcome;

    before(async () => {
      // Exactly what the server prints: `cm find merge` gave
      // <SRCBRANCH>br:/Engine%202019.4.19f1</SRCBRANCH>.
      outcome = await parseLines(wrap(merge({
        DSTBRANCH: "br:/main",
        DSTCHANGESET: "2941",
        SRCBRANCH: "br:/Engine%202019.4.19f1",
        SRCCHANGESET: "2921",
        TYPE: "merge",
      })));
    });

    it("reads back the plain name the rest of the model uses", () => {
      expect(outcome.result![0].sourceBranch).to.equal("/Engine 2019.4.19f1");
    });
  });

  context("When a branch name contains a literal percent sign", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(merge({
        DSTBRANCH: "br:/main",
        DSTCHANGESET: "2",
        SRCBRANCH: "br:/100%-coverage",
        SRCCHANGESET: "1",
        TYPE: "merge",
      })));
    });

    it("leaves it alone, where decodeURIComponent would throw on the lone percent", () => {
      expect(outcome.result![0].sourceBranch).to.equal("/100%-coverage");
    });
  });

  context("When id fields are empty or missing", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(merge({ DSTCHANGESET: "", SRCBRANCH: "br:/main", TYPE: "merge" })));
    });

    it("reads them as -1", () => {
      expect(outcome.result![0].sourceChangesetId).to.equal(-1);
      expect(outcome.result![0].destinationChangesetId).to.equal(-1);
    });

    it("reads a missing branch as an empty string", () => {
      expect(outcome.result![0].destinationBranch).to.equal("");
    });
  });

  context("When the XML is malformed", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([ XML_HEADER, "<PLASTICQUERY>", "<MERGE>", "</PLASTICQUERY>" ]);
    });

    it("produces an undefined result and an error", () => {
      expect(outcome.result).to.be.undefined;
      expect(outcome.error).to.be.not.undefined;
    });
  });
});
