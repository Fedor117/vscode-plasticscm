import { expect } from "chai";
import { ILabelInfo } from "../../../../../models";
import { ListLabelsParser } from "../../../../../cm/commands/listLabels/listLabelsParser";

const XML_HEADER = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>";

/** The shape `cm find label --xml` prints in cm 11; the values are invented. */
const RELEASE_LABEL: string[] = [
  "  <MARKER>",
  "    <ID>4401</ID>",
  "    <COMMENT>Hotfix &amp; store build</COMMENT>",
  "    <DATE>2026-04-14T09:30:00+00:00</DATE>",
  "    <OWNER>someone@example.com</OWNER>",
  "    <NAME>Release 1.0 (Android)</NAME>",
  "    <CHANGESET>912</CHANGESET>",
  "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
  "    <REPNAME>Nimbus/Nimbus</REPNAME>",
  "    <REPSERVER>acme-studio@unity</REPSERVER>",
  "    <BRANCH>/main/release_1</BRANCH>",
  "    <BRANCHID>412</BRANCHID>",
  "  </MARKER>",
];

const BETA_LABEL: string[] = [
  "  <MARKER>",
  "    <ID>4400</ID>",
  "    <COMMENT></COMMENT>",
  "    <DATE>2026-04-01T08:00:00+00:00</DATE>",
  "    <OWNER>admin</OWNER>",
  "    <NAME>beta</NAME>",
  "    <CHANGESET>870</CHANGESET>",
  "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
  "    <REPNAME>Nimbus/Nimbus</REPNAME>",
  "    <REPSERVER>acme-studio@unity</REPSERVER>",
  "    <BRANCH>/main</BRANCH>",
  "    <BRANCHID>3</BRANCHID>",
  "  </MARKER>",
];

function wrap(...rows: string[][]): string[] {
  return [
    XML_HEADER, "<PLASTICQUERY>", ...rows.reduce<string[]>((all, row) => all.concat(row), []), "</PLASTICQUERY>",
  ];
}

async function parse(lines: string[]): Promise<{ result?: ILabelInfo[]; error?: Error }> {
  const parser = new ListLabelsParser();
  lines.forEach(line => parser.readLineOut(line));
  const result = await parser.parse();
  return { error: parser.getError(), result };
}

describe("ListLabels Parser", () => {
  it("reads an empty query as an empty list", async () => {
    expect(await parse([ XML_HEADER, "<PLASTICQUERY>", "</PLASTICQUERY>" ])).to.eql({ error: undefined, result: [] });
  });

  it("reads every field of a label", async () => {
    const { result, error } = await parse(wrap(RELEASE_LABEL));
    expect(error).to.be.undefined;
    expect(result).to.eql([{
      branch: "/main/release_1",
      changesetId: 912,
      comment: "Hotfix & store build",
      date: new Date("2026-04-14T09:30:00+00:00"),
      id: 4401,
      name: "Release 1.0 (Android)",
      owner: "someone@example.com",
      repository: "Nimbus/Nimbus",
      server: "acme-studio@unity",
    }]);
  });

  it("keeps cm's order for several labels", async () => {
    const { result } = await parse(wrap(RELEASE_LABEL, BETA_LABEL));
    expect(result!.map(l => l.name)).to.eql([ "Release 1.0 (Android)", "beta" ]);
    expect(result![1].comment).to.equal("");
  });

  it("reports malformed XML", async () => {
    const { result, error } = await parse([ XML_HEADER, "<PLASTICQUERY>", "<MARKER>", "</PLASTICQUERY>" ]);
    expect(result).to.be.undefined;
    expect(error).to.not.be.undefined;
  });
});
