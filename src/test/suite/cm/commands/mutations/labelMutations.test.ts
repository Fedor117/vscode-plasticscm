import { CreateLabel, DeleteLabel, RenameLabel } from "../../../../../cm/commands";
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

describe("CreateLabel command", () => {
  it("passes the label and the changeset", async () => {
    const shell = mockShell(OK);
    await CreateLabel.run(shell.mock.object, channel, { changeset: 1203, name: "BL001" });
    expect(shell.calls).to.eql([{ args: [ "create", "lb:BL001", "cs:1203" ], command: "label" }]);
  });

  it("adds a comments file when there is a comment", async () => {
    const shell = mockShell(OK);
    await CreateLabel.run(shell.mock.object, channel, { changeset: 7, comment: "first release", name: "BL002" });
    expect(shell.calls[0].args.slice(0, 3)).to.eql([ "create", "lb:BL002", "cs:7" ]);
    expect(shell.calls[0].args[3]).to.match(/^-commentsfile=/);
  });

  it("rejects a name with a quote or a line break without calling cm", async () => {
    const shell = mockShell(OK);
    for (const name of [ "a\"b", "a\nb", "", " a", "a@b" ]) {
      const error = await runCatching(() => CreateLabel.run(shell.mock.object, channel, { changeset: 1, name }));
      expect(error, JSON.stringify(name)).to.be.instanceOf(Error);
    }
    expect(shell.calls).to.eql([]);
  });

  it("rejects a changeset that is not an integer", async () => {
    const shell = mockShell(OK);
    const error = await runCatching(() => CreateLabel.run(shell.mock.object, channel, { changeset: NaN, name: "a" }));
    expect(error?.message).to.contain("integer");
  });
});

describe("RenameLabel command", () => {
  it("passes the label spec and the new name", async () => {
    const shell = mockShell(OK);
    await RenameLabel.run(shell.mock.object, "BL001", "BL002");
    expect(shell.calls).to.eql([{ args: [ "rename", "lb:BL001", "BL002" ], command: "label" }]);
  });

  it("rejects a new name cm would read as an option", async () => {
    const shell = mockShell(OK);
    const error = await runCatching(() => RenameLabel.run(shell.mock.object, "BL001", "--help"));
    expect(error).to.be.instanceOf(Error);
    expect(shell.calls).to.eql([]);
  });
});

describe("DeleteLabel command", () => {
  it("passes the label spec", async () => {
    const shell = mockShell(OK);
    await DeleteLabel.run(shell.mock.object, "BL001");
    expect(shell.calls).to.eql([{ args: [ "delete", "lb:BL001" ], command: "label" }]);
  });

  it("surfaces cm's error", async () => {
    const shell = mockShell<string[]>({ error: new Error("Label not found"), success: false });
    const error = await runCatching(() => DeleteLabel.run(shell.mock.object, "BL001"));
    expect(error?.message).to.equal("Label not found");
  });
});
