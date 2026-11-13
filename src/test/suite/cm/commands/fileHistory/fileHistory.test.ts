import { IShellMock, mockShell } from "../findChangesets/shellMock";
import { expect } from "chai";
import { FileHistory } from "../../../../../cm/commands/fileHistory/fileHistory";
import { FileHistoryParser } from "../../../../../cm/commands/fileHistory/fileHistoryParser";
import { IFileRevision } from "../../../../../models";

/** The shape `cm history --xml` prints in cm 11; the names and ids are invented. */
const HISTORY_XML = `<?xml version="1.0" encoding="utf-8"?>
<RevisionHistoriesResult>
  <RevisionHistories>
    <RevisionHistory>
      <ItemName>/work/Nimbus/Assets/Scripts/Player.cs</ItemName>
      <Revisions>
        <Revision>
          <RevisionSpec>./Assets/Scripts/Player.cs#cs:40</RevisionSpec>
          <Branch>/main</Branch>
          <CreationDate>2026-03-01T10:00:00+00:00</CreationDate>
          <RevisionType>txt</RevisionType>
          <ChangesetNumber>40</ChangesetNumber>
          <Owner>someone@example.com</Owner>
          <Comment>First version

with a second paragraph</Comment>
          <Repository>Nimbus/Nimbus</Repository>
          <Server>acme-studio@unity</Server>
          <RepositorySpec>
            <Server>acme-studio@unity</Server>
            <Name>Nimbus/Nimbus</Name>
          </RepositorySpec>
          <DataStatus>Available</DataStatus>
          <ItemPathOrSpec>./Assets/Scripts/Player.cs</ItemPathOrSpec>
          <ItemId>9001</ItemId>
          <Size>1200</Size>
          <Hash>AAAAAAAAAAAAAAAAAAAAAA==</Hash>
          <HashAlgorithm>MD5</HashAlgorithm>
        </Revision>
        <Revision>
          <RevisionSpec>./Assets/Scripts/Player.cs#cs:57</RevisionSpec>
          <Branch>/main/task7</Branch>
          <CreationDate>2026-03-09T16:30:00+00:00</CreationDate>
          <RevisionType>txt</RevisionType>
          <ChangesetNumber>57</ChangesetNumber>
          <Owner>admin</Owner>
          <Repository>Nimbus/Nimbus</Repository>
          <Server>acme-studio@unity</Server>
          <DataStatus>Available</DataStatus>
          <ItemPathOrSpec>./Assets/Scripts/Player.cs</ItemPathOrSpec>
          <ItemId>9001</ItemId>
          <Size>1342</Size>
        </Revision>
      </Revisions>
    </RevisionHistory>
  </RevisionHistories>
</RevisionHistoriesResult>`;

async function parse(xml: string): Promise<IFileRevision[] | undefined> {
  const parser = new FileHistoryParser();
  xml.split("\n").forEach(line => parser.readLineOut(line));
  return parser.parse();
}

describe("FileHistoryParser", () => {
  it("reads every revision, newest first", async () => {
    const revisions = (await parse(HISTORY_XML))!;
    expect(revisions.map(revision => revision.changesetId)).to.eql([ 57, 40 ]);
  });

  it("reads the fields of a revision, keeping a multi-line comment", async () => {
    const revisions = (await parse(HISTORY_XML))!;
    expect(revisions[1]).to.eql({
      branch: "/main",
      changesetId: 40,
      comment: "First version\n\nwith a second paragraph",
      date: new Date("2026-03-01T10:00:00+00:00"),
      itemId: 9001,
      owner: "someone@example.com",
      repository: "Nimbus/Nimbus",
      server: "acme-studio@unity",
      size: 1200,
      spec: "./Assets/Scripts/Player.cs#cs:40",
      type: "txt",
    });
  });

  it("treats a missing comment as empty", async () => {
    const revisions = (await parse(HISTORY_XML))!;
    expect(revisions[0].comment).to.equal("");
  });

  it("reads one revision as a list of one", async () => {
    const one = HISTORY_XML.replace(/<Revision>(?:(?!<\/Revision>)[\s\S])*<\/Revision>\s*(?=<Revision>)/, "");
    expect((await parse(one))!.map(revision => revision.changesetId)).to.eql([57]);
  });

  it("returns an empty list for an item with no histories", async () => {
    const empty = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<RevisionHistoriesResult />";
    expect(await parse(empty)).to.eql([]);
  });

  it("reports a document that is not XML", async () => {
    const parser = new FileHistoryParser();
    parser.readLineOut("<RevisionHistoriesResult><Unclosed>");
    expect(await parser.parse()).to.equal(undefined);
    expect(parser.getError()).to.be.instanceOf(Error);
  });
});

describe("FileHistory command", () => {
  it("asks for the XML history including moves and removals", async () => {
    const revisions = (await parse(HISTORY_XML))!;
    const shell: IShellMock = mockShell({ result: revisions, success: true });
    const result = await FileHistory.run(shell.mock.object, "/work/Nimbus/Assets/Scripts/Player.cs");

    expect(result).to.eql(revisions);
    expect(shell.calls).to.eql([{
      args: [ "/work/Nimbus/Assets/Scripts/Player.cs", "--xml", "--encoding=utf-8", "--moveddeleted" ],
      command: "history",
    }]);
  });

  it("throws cm's message when the item does not exist", async () => {
    const shell = mockShell<IFileRevision[]>({ error: new Error("The item does not exist."), success: false });
    let message = "";
    try {
      await FileHistory.run(shell.mock.object, "/work/Nimbus/missing.cs");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.equal("The item does not exist.");
  });

  it("refuses a path that contains a quote, before cm is called", async () => {
    const shell = mockShell<IFileRevision[]>({ result: [], success: true });
    let failed = false;
    try {
      await FileHistory.run(shell.mock.object, "/work/a\"b.cs");
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    expect(shell.calls).to.eql([]);
  });
});
