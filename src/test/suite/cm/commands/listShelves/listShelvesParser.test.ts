import { expect } from "chai";
import { IShelveInfo } from "../../../../../models";
import { ListShelvesParser } from "../../../../../cm/commands/listShelves/listShelvesParser";

const XML_HEADER = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>";

/** The shape `cm find shelve --xml` prints in cm 11; the values are invented. */
const WIP_SHELVE: string[] = [
  "  <SHELVE>",
  "    <ID>5101</ID>",
  "    <SHELVEID>32</SHELVEID>",
  "    <COMMENT>WIP: inventory &lt;refactor&gt;</COMMENT>",
  "    <DATE>2026-03-02T10:15:00+00:00</DATE>",
  "    <OWNER>someone@example.com</OWNER>",
  "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
  "    <REPNAME>Nimbus/Nimbus</REPNAME>",
  "    <REPSERVER>acme-studio@unity</REPSERVER>",
  "    <PARENT>880</PARENT>",
  "    <GUID>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</GUID>",
  "  </SHELVE>",
];

const OTHER_SHELVE: string[] = [
  "  <SHELVE>",
  "    <ID>5102</ID>",
  "    <SHELVEID>48</SHELVEID>",
  "    <COMMENT></COMMENT>",
  "    <DATE>2026-03-04T16:40:00+00:00</DATE>",
  "    <OWNER>admin</OWNER>",
  "    <REPOSITORY>Nimbus/Nimbus</REPOSITORY>",
  "    <REPNAME>Nimbus/Nimbus</REPNAME>",
  "    <REPSERVER>acme-studio@unity</REPSERVER>",
  "    <PARENT></PARENT>",
  "    <GUID>22222222-3333-4444-5555-666666666666</GUID>",
  "  </SHELVE>",
];

function wrap(...rows: string[][]): string[] {
  return [
    XML_HEADER, "<PLASTICQUERY>", ...rows.reduce<string[]>((all, row) => all.concat(row), []), "</PLASTICQUERY>",
  ];
}

async function parse(lines: string[]): Promise<{ result?: IShelveInfo[]; error?: Error }> {
  const parser = new ListShelvesParser();
  lines.forEach(line => parser.readLineOut(line));
  const result = await parser.parse();
  return { error: parser.getError(), result };
}

describe("ListShelves Parser", () => {
  it("reads an empty query as an empty list", async () => {
    expect(await parse([ XML_HEADER, "<PLASTICQUERY>", "</PLASTICQUERY>" ])).to.eql({ error: undefined, result: [] });
  });

  it("reads every field of a shelve", async () => {
    const { result, error } = await parse(wrap(WIP_SHELVE));
    expect(error).to.be.undefined;
    expect(result).to.eql([{
      comment: "WIP: inventory <refactor>",
      date: new Date("2026-03-02T10:15:00+00:00"),
      guid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      id: 5101,
      owner: "someone@example.com",
      parentChangesetId: 880,
      repository: "Nimbus/Nimbus",
      server: "acme-studio@unity",
      shelveId: 32,
    }]);
  });

  it("keeps cm's order and reads an empty parent as -1", async () => {
    const { result } = await parse(wrap(WIP_SHELVE, OTHER_SHELVE));
    expect(result!.map(s => s.shelveId)).to.eql([ 32, 48 ]);
    expect(result![1].parentChangesetId).to.equal(-1);
  });

  it("reports malformed XML", async () => {
    const { result, error } = await parse([ XML_HEADER, "<PLASTICQUERY>", "<SHELVE>", "</PLASTICQUERY>" ]);
    expect(result).to.be.undefined;
    expect(error).to.not.be.undefined;
  });
});
