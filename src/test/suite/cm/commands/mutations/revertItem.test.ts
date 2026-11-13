import { expect } from "chai";
import { mockShell } from "../findChangesets/shellMock";
import { RevertItem } from "../../../../../cm/commands";

async function failure(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("RevertItem command", () => {
  it("reverts the path to the changeset", async () => {
    const shell = mockShell({ result: ["done"], success: true });
    const lines = await RevertItem.run(shell.mock.object, "/work/Nimbus/a b.txt", 57);
    expect(shell.calls).to.eql([{ args: ["/work/Nimbus/a b.txt#cs:57"], command: "revert" }]);
    expect(lines).to.eql(["done"]);
  });

  it("throws cm's message when the revert fails", async () => {
    const shell = mockShell({ error: new Error("item is not checked in"), success: false });
    expect(await failure(() => RevertItem.run(shell.mock.object, "/work/a.txt", 3))).to.equal("item is not checked in");
  });

  it("refuses what cm would read as another spec, a quote or a fractional changeset", async () => {
    const shell = mockShell({ result: [], success: true });
    expect(await failure(() => RevertItem.run(shell.mock.object, "/work/a#1.txt", 3))).to.contain("'#'");
    expect(await failure(() => RevertItem.run(shell.mock.object, "/work/a\".txt", 3))).to.contain("cannot be passed");
    expect(await failure(() => RevertItem.run(shell.mock.object, "/work/a.txt", 1.5))).to.contain("integer");
    expect(shell.calls).to.eql([]);
  });
});
