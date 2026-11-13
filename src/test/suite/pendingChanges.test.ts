import {
  confirmPendingChanges,
  CONTINUE_LABEL,
  countPendingChanges,
  IPendingChangesHandler,
  pendingChangesDetail,
} from "../../commands/pendingChanges";
import { expect } from "chai";
import { Workspace } from "../../workspace";

function fakeWorkspace(privateFlags: boolean[]): Workspace {
  return {
    info: { name: "Nimbus" },
    pendingChanges: privateFlags.map(isPrivate => ({ isPrivate })),
  } as unknown as Workspace;
}

const SWITCH = { kind: "switch", target: "branch /main/task001" } as const;
const UPDATE = { kind: "update", target: "'Nimbus'" } as const;

describe("pending changes", () => {
  it("counts only controlled changes: private files do not block a switch", () => {
    expect(countPendingChanges([])).to.equal(0);
    expect(countPendingChanges([{ isPrivate: true }, { isPrivate: false }, { isPrivate: false }])).to.equal(2);
  });

  it("says what cm's help says about --noinput, and no more", () => {
    const detail = pendingChangesDetail(SWITCH, []);
    expect(detail).to.contain("--noinput");
    expect(detail).to.contain("disables bringing your pending changes");
    expect(detail).to.contain("does not say what happens");
  });

  it("names the handlers' buttons in the detail", () => {
    const handler: IPendingChangesHandler = { label: "Shelve and Switch", run: () => Promise.resolve(true) };
    expect(pendingChangesDetail(SWITCH, [handler])).to.contain("\"Shelve and Switch\"");
  });

  context("When asking", () => {
    it("does not ask when there is nothing pending", async () => {
      let asked = false;
      const result = await confirmPendingChanges(fakeWorkspace([ true, true ]), SWITCH, [], () => {
        asked = true;
        return Promise.resolve(CONTINUE_LABEL);
      });
      expect(result).to.equal(true);
      expect(asked).to.equal(false);
    });

    it("names the target and the count for a switch, with Continue as the only button", async () => {
      let asked: { message: string; buttons: string[] } | undefined;
      await confirmPendingChanges(fakeWorkspace([false]), SWITCH, [], (message, _detail, buttons) => {
        asked = { buttons, message };
        return Promise.resolve(undefined);
      });
      expect(asked).to.eql({
        buttons: [CONTINUE_LABEL],
        message: "Switching to branch /main/task001 with 1 pending change?",
      });
    });

    it("names the workspace for an update", async () => {
      let message = "";
      await confirmPendingChanges(fakeWorkspace([ false, false ]), UPDATE, [], m => {
        message = m;
        return Promise.resolve(undefined);
      });
      expect(message).to.equal("Updating 'Nimbus' with 2 pending changes?");
    });

    it("stops on cancel", async () => {
      expect(await confirmPendingChanges(fakeWorkspace([false]), SWITCH, [], () => Promise.resolve(undefined)))
        .to.equal(false);
    });

    it("goes on after Continue", async () => {
      expect(await confirmPendingChanges(fakeWorkspace([false]), SWITCH, [], () => Promise.resolve(CONTINUE_LABEL)))
        .to.equal(true);
    });

    it("hands over to the handler whose button was chosen", async () => {
      const calls: string[] = [];
      const handler: IPendingChangesHandler = {
        label: "Shelve and Switch",
        run: (workspace, action) => {
          calls.push(`${workspace.info.name}:${action.kind}`);
          return Promise.resolve(true);
        },
      };
      let buttons: string[] = [];
      const result = await confirmPendingChanges(fakeWorkspace([false]), SWITCH, [handler], (_m, _d, offered) => {
        buttons = offered;
        return Promise.resolve("Shelve and Switch");
      });

      expect(buttons).to.eql([ CONTINUE_LABEL, "Shelve and Switch" ]);
      expect(result).to.equal(true);
      expect(calls).to.eql(["Nimbus:switch"]);
    });

    it("stops when the handler says so", async () => {
      const handler: IPendingChangesHandler = { label: "Shelve and Switch", run: () => Promise.resolve(false) };
      expect(await confirmPendingChanges(
        fakeWorkspace([false]), SWITCH, [handler], () => Promise.resolve("Shelve and Switch"))).to.equal(false);
    });
  });
});
