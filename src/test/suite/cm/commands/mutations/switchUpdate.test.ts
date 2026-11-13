import { switchSpec, SwitchWorkspace, UpdateWorkspace } from "../../../../../cm/commands";
import { expect } from "chai";
import { LONG_COMMAND_TIMEOUT_MILLIS } from "../../../../../cm/commands/runMutation";
import { mockShell } from "../findChangesets/shellMock";

const OK = { result: [], success: true };

async function runCatching(action: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await action();
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe("SwitchWorkspace command", () => {
  it("switches to a branch with --noinput and a bound", async () => {
    const shell = mockShell(OK);
    await SwitchWorkspace.run(shell.mock.object, { kind: "branch", name: "/main/task001" });
    expect(shell.calls).to.eql([{
      args: [ "br:/main/task001", "--noinput" ],
      command: "switch",
      options: { timeoutMillis: LONG_COMMAND_TIMEOUT_MILLIS },
    }]);
  });

  it("switches to a changeset", async () => {
    const shell = mockShell(OK);
    await SwitchWorkspace.run(shell.mock.object, { id: 4375, kind: "changeset" });
    expect(shell.calls[0].args).to.eql([ "cs:4375", "--noinput" ]);
  });

  it("switches to a label", async () => {
    const shell = mockShell(OK);
    await SwitchWorkspace.run(shell.mock.object, { kind: "label", name: "Rel1.1" });
    expect(shell.calls[0].args).to.eql([ "lb:Rel1.1", "--noinput" ]);
  });

  it("rejects a target cm cannot be given, without calling cm", async () => {
    const shell = mockShell(OK);
    for (const target of [
      { kind: "branch", name: "main" },
      { kind: "branch", name: "/main/a\"b" },
      { id: 1.5, kind: "changeset" },
      { kind: "label", name: "a\nb" },
    ] as const) {
      expect(await runCatching(() => SwitchWorkspace.run(shell.mock.object, target))).to.be.instanceOf(Error);
    }
    expect(shell.calls).to.eql([]);
  });

  it("throws cm's error when the switch fails", async () => {
    const shell = mockShell<string[]>({ error: new Error("Unable to switch"), success: false });
    const error = await runCatching(() => SwitchWorkspace.run(shell.mock.object, { id: 1, kind: "changeset" }));
    expect(error?.message).to.equal("Unable to switch");
  });

  it("builds the spec of each kind", () => {
    expect(switchSpec({ kind: "branch", name: "/main" })).to.equal("br:/main");
    expect(switchSpec({ id: 0, kind: "changeset" })).to.equal("cs:0");
    expect(switchSpec({ kind: "label", name: "v1" })).to.equal("lb:v1");
  });
});

describe("UpdateWorkspace command", () => {
  it("updates the workspace with --noinput and a bound", async () => {
    const shell = mockShell(OK);
    await UpdateWorkspace.run(shell.mock.object);
    expect(shell.calls).to.eql([{
      args: ["--noinput"],
      command: "update",
      options: { timeoutMillis: LONG_COMMAND_TIMEOUT_MILLIS },
    }]);
  });

  it("passes --last first for a workspace on a changeset or label", async () => {
    const shell = mockShell(OK);
    await UpdateWorkspace.run(shell.mock.object, { last: true });
    expect(shell.calls[0].args).to.eql([ "--last", "--noinput" ]);
  });

  it("returns what cm printed", async () => {
    const shell = mockShell({ result: [ "Updating…", "Done" ], success: true });
    expect(await UpdateWorkspace.run(shell.mock.object)).to.eql([ "Updating…", "Done" ]);
  });

  it("throws a generic error when cm fails without a message", async () => {
    const shell = mockShell<string[]>({ success: false });
    const error = await runCatching(() => UpdateWorkspace.run(shell.mock.object));
    expect(error?.message).to.equal("cm update failed.");
  });
});
