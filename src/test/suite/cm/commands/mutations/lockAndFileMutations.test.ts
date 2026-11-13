import { Checkout, MoveItem, RemoveItems, UnlockItems } from "../../../../../cm/commands";
import { expect } from "chai";
import { mockShell } from "../findChangesets/shellMock";

const OK = { result: ["done"], success: true };

async function failure(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("Checkout command", () => {
  it("checks the paths out in machine readable form", async () => {
    const shell = mockShell(OK);
    const lines = await Checkout.run(shell.mock.object, [ "/work/Nimbus/a.txt", "/work/Nimbus/b b.txt" ]);
    expect(shell.calls).to.eql([{
      args: [ "/work/Nimbus/a.txt", "/work/Nimbus/b b.txt", "--machinereadable" ],
      command: "checkout",
    }]);
    expect(lines).to.eql(["done"]);
  });

  it("throws cm's message when the checkout fails", async () => {
    const shell = mockShell({ error: new Error("locked by someone"), success: false });
    expect(await failure(() => Checkout.run(shell.mock.object, ["/work/a.txt"]))).to.equal("locked by someone");
  });

  it("refuses an empty list and a path cm's shell could not quote", async () => {
    const shell = mockShell(OK);
    expect(await failure(() => Checkout.run(shell.mock.object, []))).to.contain("nothing to check out");
    expect(await failure(() => Checkout.run(shell.mock.object, ['/work/a"b.txt']))).to.contain("cannot be passed");
    expect(shell.calls).to.eql([]);
  });
});

describe("UnlockItems command", () => {
  it("releases the locks of the item specs", async () => {
    const shell = mockShell(OK);
    await UnlockItems.run(shell.mock.object, ["itemid:812@Nimbus/Nimbus@acme-studio@unity"], false);
    expect(shell.calls).to.eql([{
      args: [ "unlock", "itemid:812@Nimbus/Nimbus@acme-studio@unity" ],
      command: "lock",
    }]);
  });

  it("adds --remove to delete the lock records", async () => {
    const shell = mockShell(OK);
    await UnlockItems.run(shell.mock.object, [ "itemid:1@r", "itemid:2@r" ], true);
    expect(shell.calls[0].args).to.eql([ "unlock", "itemid:1@r", "itemid:2@r", "--remove" ]);
  });

  it("throws cm's error and refuses an empty list", async () => {
    const shell = mockShell({ error: new Error("not an administrator"), success: false });
    expect(await failure(() => UnlockItems.run(shell.mock.object, ["itemid:1@r"], false)))
      .to.equal("not an administrator");
    expect(await failure(() => UnlockItems.run(shell.mock.object, [], false))).to.contain("no lock");
  });
});

describe("RemoveItems command", () => {
  it("removes the paths", async () => {
    const shell = mockShell(OK);
    await RemoveItems.run(shell.mock.object, [ "/work/Nimbus/old.txt", "/work/Nimbus/Old Dir" ]);
    expect(shell.calls).to.eql([{ args: [ "/work/Nimbus/old.txt", "/work/Nimbus/Old Dir" ], command: "remove" }]);
  });

  it("refuses an empty list and a quote", async () => {
    const shell = mockShell(OK);
    expect(await failure(() => RemoveItems.run(shell.mock.object, []))).to.contain("nothing to delete");
    expect(await failure(() => RemoveItems.run(shell.mock.object, ['a"b']))).to.contain("cannot be passed");
  });

  it("throws cm's error", async () => {
    const shell = mockShell({ error: new Error("item is not controlled"), success: false });
    expect(await failure(() => RemoveItems.run(shell.mock.object, ["/work/a.txt"]))).to.equal("item is not controlled");
  });
});

describe("MoveItem command", () => {
  it("moves the source to the destination", async () => {
    const shell = mockShell(OK);
    await MoveItem.run(shell.mock.object, "/work/Nimbus/a.txt", "/work/Nimbus/docs/b.txt");
    expect(shell.calls).to.eql([{ args: [ "/work/Nimbus/a.txt", "/work/Nimbus/docs/b.txt" ], command: "move" }]);
  });

  it("refuses a destination with a quote or a line break", async () => {
    const shell = mockShell(OK);
    expect(await failure(() => MoveItem.run(shell.mock.object, "/a", '/b"c'))).to.contain("cannot be passed");
    expect(await failure(() => MoveItem.run(shell.mock.object, "/a", "/b\nc"))).to.contain("cannot be passed");
  });

  it("throws cm's error", async () => {
    const shell = mockShell({ error: new Error("destination exists"), success: false });
    expect(await failure(() => MoveItem.run(shell.mock.object, "/a", "/b"))).to.equal("destination exists");
  });
});
