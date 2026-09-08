import { expect } from "chai";
import { FindChangesetsParser } from "../../../../../cm/commands/findChangesets/findChangesetsParser";
import { IHistoryChangeset } from "../../../../../models";

const XML_HEADER = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>";

const SAMPLE_CHANGESET: string[] = [
  "  <CHANGESET>",
  "    <ID>12251</ID>",
  "    <CHANGESETID>3622</CHANGESETID>",
  "    <COMMENT>Localisation key for Lap counter label in GaragePopup.prefab </COMMENT>",
  "    <DATE>2026-09-07T16:56:14+01:00</DATE>",
  "    <OWNER>dana.kim@example.com</OWNER>",
  "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
  "    <REPNAME>Nimbus/Nimbus</REPNAME>",
  "    <REPSERVER>acme-studio@unity</REPSERVER>",
  "    <BRANCH>/main/release_3</BRANCH>",
  "    <PARENT>3621</PARENT>",
  "    <GUID>cafe0001-4b1d-4c2e-9d3f-5a6b7c8d9e0f</GUID>",
  "    <ROOTREV>12321</ROOTREV>",
  "  </CHANGESET>",
];

const ROOT_CHANGESET: string[] = [
  "  <CHANGESET>",
  "    <ID>1</ID>",
  "    <CHANGESETID>0</CHANGESETID>",
  "    <COMMENT></COMMENT>",
  "    <DATE>2019-01-01T00:00:00+00:00</DATE>",
  "    <OWNER>admin</OWNER>",
  "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
  "    <REPNAME>Nimbus/Nimbus</REPNAME>",
  "    <REPSERVER>acme-studio@unity</REPSERVER>",
  "    <BRANCH>/main</BRANCH>",
  "    <PARENT>-1</PARENT>",
  "    <GUID>00000000-0000-0000-0000-000000000000</GUID>",
  "    <ROOTREV>1</ROOTREV>",
  "  </CHANGESET>",
];

function changesetWith(fields: { [tag: string]: string }): string[] {
  return [
    "  <CHANGESET>",
    ...Object.keys(fields).map(tag => `    <${tag}>${fields[tag]}</${tag}>`),
    "  </CHANGESET>",
  ];
}

function wrap(...rows: string[][]): string[] {
  return [
    XML_HEADER, "<PLASTICQUERY>", ...rows.reduce<string[]>((all, row) => all.concat(row), []), "</PLASTICQUERY>",
  ];
}

interface IParseOutcome {
  error: Error | undefined;
  outputLines: string[];
  result: IHistoryChangeset[] | undefined;
}

async function parseLines(stdout: string[], stderr: string[] = []): Promise<IParseOutcome> {
  const parser = new FindChangesetsParser();
  stdout.forEach(line => parser.readLineOut(line));
  stderr.forEach(line => parser.readLineErr(line));
  // parse() sets the parse error, so it has to run before getError() is read.
  const result = await parser.parse();
  return {
    error: parser.getError(),
    outputLines: parser.getOutputLines(),
    result,
  };
}

describe("FindChangesets Parser", () => {
  context("When there is no input", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([]);
    });

    it("produces an empty list", () => {
      expect(outcome.result).to.eql([]);
    });

    it("doesn't produce any error", () => {
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

  context("When the query matches one changeset", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(SAMPLE_CHANGESET));
    });

    it("normalizes the single row into a list", () => {
      expect(outcome.result).to.have.lengthOf(1);
    });

    it("reads every field", () => {
      expect(outcome.result![0]).to.eql({
        branch: "/main/release_3",
        comment: "Localisation key for Lap counter label in GaragePopup.prefab",
        date: new Date("2026-09-07T16:56:14+01:00"),
        guid: "cafe0001-4b1d-4c2e-9d3f-5a6b7c8d9e0f",
        id: 3622,
        owner: "dana.kim@example.com",
        parentId: 3621,
        repository: "Nimbus/Nimbus",
        server: "acme-studio@unity",
      });
    });

    it("converts ids to numbers", () => {
      expect(outcome.result![0].id).to.be.a("number");
      expect(outcome.result![0].parentId).to.be.a("number");
    });

    it("doesn't produce any error", () => {
      expect(outcome.error).to.be.undefined;
    });
  });

  context("When the query matches several changesets", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(SAMPLE_CHANGESET, ROOT_CHANGESET));
    });

    it("keeps cm's order", () => {
      expect(outcome.result!.map(cs => cs.id)).to.eql([ 3622, 0 ]);
    });

    it("reads the root changeset's -1 parent", () => {
      expect(outcome.result![1].parentId).to.equal(-1);
    });

    it("reads an empty comment as an empty string", () => {
      expect(outcome.result![1].comment).to.equal("");
    });
  });

  context("When comments look like numbers", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(
        changesetWith({ CHANGESETID: "2", COMMENT: "007", PARENT: "1" }),
        changesetWith({ CHANGESETID: "3", COMMENT: "1e3", PARENT: "2" })));
    });

    it("preserves them as text", () => {
      expect(outcome.result!.map(cs => cs.comment)).to.eql([ "007", "1e3" ]);
    });
  });

  context("When a comment spans several lines", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap([
        "  <CHANGESET>",
        "    <CHANGESETID>10</CHANGESETID>",
        "    <COMMENT>First line",
        "Second line",
        "Third line</COMMENT>",
        "    <PARENT>9</PARENT>",
        "  </CHANGESET>",
      ]));
    });

    it("joins the lines with a line feed", () => {
      expect(outcome.result![0].comment).to.equal("First line\nSecond line\nThird line");
    });
  });

  context("When a comment contains XML entities", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(
        changesetWith({ CHANGESETID: "11", COMMENT: "Fix a &amp; b &lt;c&gt; &quot;d&quot;", PARENT: "10" })));
    });

    it("decodes them", () => {
      expect(outcome.result![0].comment).to.equal("Fix a & b <c> \"d\"");
    });
  });

  context("When the date cannot be parsed", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(
        changesetWith({ CHANGESETID: "12", DATE: "not a date", PARENT: "11" })));
    });

    it("falls back to the epoch", () => {
      expect(outcome.result![0].date.getTime()).to.equal(0);
    });
  });

  context("When id fields are empty or missing", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(wrap(changesetWith({ CHANGESETID: "", COMMENT: "x" })));
    });

    it("reads them as -1", () => {
      expect(outcome.result![0].id).to.equal(-1);
      expect(outcome.result![0].parentId).to.equal(-1);
    });

    it("reads missing text fields as empty strings", () => {
      expect(outcome.result![0].branch).to.equal("");
      expect(outcome.result![0].owner).to.equal("");
    });
  });

  context("When the XML is malformed", () => {
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines([ XML_HEADER, "<PLASTICQUERY>", "<CHANGESET>", "</PLASTICQUERY>" ]);
    });

    it("produces an undefined result", () => {
      expect(outcome.result).to.be.undefined;
    });
  });

  context("When there are error lines", () => {
    const stdout = wrap(SAMPLE_CHANGESET);
    const stderr = [ "error1", "error2" ];
    let outcome: IParseOutcome;

    before(async () => {
      outcome = await parseLines(stdout, stderr);
    });

    it("still parses the output", () => {
      expect(outcome.result).to.have.lengthOf(1);
    });

    it("holds the output correctly", () => {
      expect(outcome.outputLines).to.eql(stdout.concat(stderr));
    });

    it("produces an error with the stderr text", () => {
      expect(outcome.error).to.be.not.undefined;
      expect(outcome.error!.message).to.contain("error1");
      expect(outcome.error!.message).to.contain("error2");
    });
  });
});
