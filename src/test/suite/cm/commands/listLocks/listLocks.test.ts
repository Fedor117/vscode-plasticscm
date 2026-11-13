import { ListLocks, LocksParser } from "../../../../../cm/commands";
import { expect } from "chai";
import { ILockInfo } from "../../../../../models";
import { mockShell } from "../findChangesets/shellMock";

const SEPARATORS = [
  "--startlineseparator=@@",
  "--endlineseparator=##",
  "--fieldseparator=~|~",
];

/** The shape `cm lock list --machinereadable --smartlocks` prints in cm 11; the values are invented. */
const LOCK_LINE =
  "@@Nimbus/Nimbus~|~812~|~7d1f0c52-1a2b-4c3d-8e9f-0a1b2c3d4e5f~|~2026-03-02 10:15:00~|~/main/art" +
  "~|~5120~|~/main/art/hero~|~5121~|~Locked~|~someone@example.com~|~NIMBUS-WK~|~/Assets/Art/Hero Model.fbx##";

const RETAINED_LINE =
  "@@Nimbus/Nimbus~|~813~|~11111111-2222-3333-4444-555555555555~|~2026-03-03 08:00:00~|~/main~|~7~|~/main/task1" +
  "~|~9~|~Retained~|~admin~|~BUILD-WK~|~/Assets/a.txt##";

async function parse(...lines: string[]): Promise<{ locks?: ILockInfo[]; error?: Error }> {
  const parser = new LocksParser();
  lines.forEach(line => parser.readLineOut(line));
  const locks = await parser.parse();
  return { error: parser.getError(), locks };
}

describe("ListLocks command", () => {
  it("asks for machine readable smart locks of any status, with explicit separators and an ISO date", async () => {
    const shell = mockShell<ILockInfo[]>({ result: [], success: true });
    await ListLocks.run(shell.mock.object);
    expect(shell.calls).to.eql([{
      args: [
        "list", "--machinereadable", "--smartlocks", "--anystatus", "--dateformat=yyyy-MM-dd HH:mm:ss", ...SEPARATORS,
      ],
      command: "lock",
    }]);
  });

  it("adds --onlycurrentuser when asked", async () => {
    const shell = mockShell<ILockInfo[]>({ result: [], success: true });
    await ListLocks.run(shell.mock.object, { onlyCurrentUser: true });
    expect(shell.calls[0].args.slice(-1)).to.eql(["--onlycurrentuser"]);
  });

  it("lists only one repository when asked", async () => {
    const shell = mockShell<ILockInfo[]>({ result: [], success: true });
    await ListLocks.run(shell.mock.object, { repository: "Nimbus/Nimbus@acme-studio@unity" });
    expect(shell.calls[0].args).to.include("--repository=Nimbus/Nimbus@acme-studio@unity");
  });

  it("refuses a repository with a quote", async () => {
    const shell = mockShell<ILockInfo[]>({ result: [], success: true });
    let message = "";
    try {
      await ListLocks.run(shell.mock.object, { repository: 'a"b' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.contain("cannot be passed to cm");
    expect(shell.calls).to.have.length(0);
  });

  it("returns what the shell parsed", async () => {
    const locks = (await parse(LOCK_LINE)).locks!;
    const shell = mockShell<ILockInfo[]>({ result: locks, success: true });
    expect(await ListLocks.run(shell.mock.object)).to.eql(locks);
  });

  it("throws cm's error", async () => {
    const shell = mockShell<ILockInfo[]>({ error: new Error("no server"), success: false });
    let message = "";
    try {
      await ListLocks.run(shell.mock.object);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.equal("no server");
  });
});

describe("LocksParser", () => {
  it("reads every field of a smart lock line, paths with spaces included", async () => {
    const { locks } = await parse(LOCK_LINE);
    expect(locks).to.eql([{
      date: "2026-03-02 10:15:00",
      destinationBranch: "/main/art",
      destinationRevisionId: 5120,
      guid: "7d1f0c52-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
      holderBranch: "/main/art/hero",
      holderRevisionId: 5121,
      itemId: 812,
      owner: "someone@example.com",
      path: "/Assets/Art/Hero Model.fbx",
      repository: "Nimbus/Nimbus",
      status: "Locked",
      workspace: "NIMBUS-WK",
    }]);
  });

  it("reads retained locks and several lines", async () => {
    const { locks } = await parse(LOCK_LINE, "", RETAINED_LINE);
    expect(locks!.map(lock => lock.status)).to.eql([ "Locked", "Retained" ]);
  });

  it("keeps a path that contains the field separator whole", async () => {
    const odd = LOCK_LINE.replace("/Assets/Art/Hero Model.fbx", "/Assets/a~|~b.txt");
    expect((await parse(odd)).locks![0].path).to.equal("/Assets/a~|~b.txt");
  });

  it("yields no locks for empty output", async () => {
    const { locks, error } = await parse();
    expect(locks).to.eql([]);
    expect(error).to.equal(undefined);
  });

  it("reports output it cannot read instead of pretending there are no locks", async () => {
    const { locks, error } = await parse("Something unexpected");
    expect(locks).to.equal(undefined);
    expect(error?.message).to.contain("Something unexpected");
  });

  it("skips a short line among good ones", async () => {
    const { locks } = await parse("@@a~|~b##", LOCK_LINE);
    expect(locks).to.have.length(1);
  });
});
