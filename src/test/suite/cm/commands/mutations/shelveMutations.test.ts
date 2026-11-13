import {
  APPLY_SHELVE_TIMEOUT_MILLIS,
  ApplyShelve,
  CreateShelve,
  DeleteShelve,
  parseCreatedShelve,
} from "../../../../../cm/commands";
import { expect } from "chai";
import { mockShell } from "../findChangesets/shellMock";

const OK = { result: [], success: true };
const channel = { appendLine: () => undefined };

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe("CreateShelve command", () => {
  it("shelves the given paths with --all and --summaryformat", async () => {
    const shell = mockShell({ result: ["sh:41"], success: true });
    const paths = [ "/work/Nimbus/a.txt", "/work/Nimbus/b.txt" ];
    const created = await CreateShelve.run(shell.mock.object, channel, { paths });
    expect(shell.calls).to.eql([{
      args: [ "create", "/work/Nimbus/a.txt", "/work/Nimbus/b.txt", "--all", "--summaryformat" ],
      command: "shelveset",
    }]);
    expect(created.shelveId).to.equal(41);
    expect(created.lines).to.eql(["sh:41"]);
  });

  it("passes the comment through a comments file", async () => {
    const shell = mockShell({ result: ["sh:7@Nimbus/Nimbus@acme-studio@unity"], success: true });
    const created = await CreateShelve.run(shell.mock.object, channel, { comment: "WIP", paths: ["/work/a.txt"] });
    const args = shell.calls[0].args;
    expect(args.slice(0, 4)).to.eql([ "create", "/work/a.txt", "--all", "--summaryformat" ]);
    expect(args[4]).to.match(/^-commentsfile=/);
    expect(created.shelveId).to.equal(7);
  });

  it("still succeeds when cm printed no spec, without a shelve id", async () => {
    const shell = mockShell({ result: ["Created"], success: true });
    const created = await CreateShelve.run(shell.mock.object, channel, { paths: ["/work/a.txt"] });
    expect(created.shelveId).to.equal(undefined);
  });

  it("refuses an empty list and paths cm cannot be given, without calling cm", async () => {
    const shell = mockShell(OK);
    for (const paths of [[], ["/work/a\"b.txt"], ["/work/a\nb.txt"], [""]]) {
      const error = await runCatching(() => CreateShelve.run(shell.mock.object, channel, { paths }));
      expect(error, JSON.stringify(paths)).to.be.instanceOf(Error);
    }
    expect(shell.calls).to.eql([]);
  });

  it("throws cm's error when the shelve fails", async () => {
    const shell = mockShell<string[]>({ error: new Error("Nothing to shelve"), success: false });
    const error = await runCatching(() => CreateShelve.run(shell.mock.object, channel, { paths: ["/work/a.txt"] }));
    expect(error?.message).to.equal("Nothing to shelve");
  });

  it("reads the number from the first sh: spec", () => {
    expect(parseCreatedShelve([ "", "sh:12" ])).to.equal(12);
    expect(parseCreatedShelve(["no spec"])).to.equal(undefined);
  });
});

describe("ApplyShelve command", () => {
  it("applies the shelve without checking files out, with a bounded timeout", async () => {
    const shell = mockShell(OK);
    await ApplyShelve.run(shell.mock.object, 41);
    expect(shell.calls).to.eql([{
      args: [ "apply", "sh:41", "--dontcheckout" ],
      command: "shelveset",
      options: { timeoutMillis: APPLY_SHELVE_TIMEOUT_MILLIS },
    }]);
    expect(APPLY_SHELVE_TIMEOUT_MILLIS).to.be.greaterThan(0);
  });

  it("previews without --dontcheckout", async () => {
    const shell = mockShell(OK);
    await ApplyShelve.run(shell.mock.object, 41, { preview: true });
    expect(shell.calls[0].args).to.eql([ "apply", "sh:41", "--preview" ]);
  });

  it("applies only the given server paths", async () => {
    const shell = mockShell(OK);
    await ApplyShelve.run(shell.mock.object, 3, { paths: ["/src/foo.c"] });
    expect(shell.calls[0].args).to.eql([ "apply", "sh:3", "/src/foo.c", "--dontcheckout" ]);
  });

  it("rejects a bad number or path without calling cm", async () => {
    const shell = mockShell(OK);
    expect(await runCatching(() => ApplyShelve.run(shell.mock.object, 1.5))).to.be.instanceOf(Error);
    const quoted = await runCatching(() => ApplyShelve.run(shell.mock.object, 1, { paths: ["/a\"b"] }));
    expect(quoted).to.be.instanceOf(Error);
    expect(shell.calls).to.eql([]);
  });

  it("throws cm's error when the apply fails", async () => {
    const shell = mockShell<string[]>({ error: new Error("Shelve not found"), success: false });
    const error = await runCatching(() => ApplyShelve.run(shell.mock.object, 99));
    expect(error?.message).to.equal("Shelve not found");
  });
});

describe("DeleteShelve command", () => {
  it("deletes the shelve spec", async () => {
    const shell = mockShell(OK);
    await DeleteShelve.run(shell.mock.object, 41);
    expect(shell.calls).to.eql([{ args: [ "delete", "sh:41" ], command: "shelveset" }]);
  });

  it("rejects a bad number without calling cm", async () => {
    const shell = mockShell(OK);
    expect(await runCatching(() => DeleteShelve.run(shell.mock.object, NaN))).to.be.instanceOf(Error);
    expect(shell.calls).to.eql([]);
  });

  it("throws cm's error when the delete fails", async () => {
    const shell = mockShell<string[]>({ error: new Error("Access denied"), success: false });
    const error = await runCatching(() => DeleteShelve.run(shell.mock.object, 2));
    expect(error?.message).to.equal("Access denied");
  });
});
