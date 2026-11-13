import { ChangeType, ILockEntry } from "../../models";
import { checkoutCandidates, describeUnlock } from "../../commands/locks";
import { groupLocks, lockItem, locksSection, lockTooltip } from "../../repository/repositorySections";
import { expect } from "chai";
import { lockNodesFromArgs } from "../../commands/targets";
import { REPOSITORY_CONTEXT } from "../../repository/repositoryTreeProvider";

function lock(path: string, owner: string, mine: boolean, guid = path): ILockEntry {
  return {
    date: "2026-03-02 10:15:00",
    destinationBranch: "/main",
    destinationRevisionId: 1,
    guid,
    holderBranch: "/main/task1",
    holderRevisionId: 2,
    itemId: 1,
    mine,
    owner,
    path,
    repository: "Nimbus/Nimbus",
    status: "Locked",
    workspace: "NIMBUS-WK",
  };
}

describe("Release and remove lock confirmations", () => {
  it("names the path of a single lock of your own, without a warning", () => {
    const text = describeUnlock([lock("/Assets/a.txt", "me", true)], false);
    expect(text.message).to.equal("Release the lock on '/Assets/a.txt'?");
    expect(text.label).to.equal("Release Lock");
    expect(text.detail).to.not.contain("WARNING");
  });

  it("warns, naming the holder, when the lock is somebody else's", () => {
    const text = describeUnlock([lock("/Assets/a.txt", "other@example.com", false)], false);
    expect(text.label).to.equal("Release Someone Else's Lock");
    expect(text.detail).to.contain("WARNING: this lock is held by other@example.com");
  });

  it("counts several locks and warns about how many are others'", () => {
    const text = describeUnlock([ lock("/a", "me", true), lock("/b", "x", false), lock("/c", "y", false) ], true);
    expect(text.message).to.equal("Remove the lock on 3 files?");
    expect(text.detail).to.contain("2 of these locks are held by x, y");
    expect(text.detail).to.contain("deleted completely");
    expect(text.label).to.equal("Remove Someone Else's Lock");
  });

  it("labels the removal of your own lock", () => {
    expect(describeUnlock([lock("/a", "me", true)], true).label).to.equal("Remove Lock");
  });
});

describe("Checkout candidates", () => {
  const state = (fsPath: string, type: ChangeType, isPrivate = false) => ({ isPrivate, resourceUri: { fsPath }, type });

  it("leaves out private, deleted and already checked out files, and passes unknown ones", () => {
    const paths = checkoutCandidates(
      [{ fsPath: "/w/a" }, { fsPath: "/w/b" }, { fsPath: "/w/c" }, { fsPath: "/w/d" }, { fsPath: "/w/e" }],
      [
        state("/w/a", ChangeType.Private, true),
        state("/w/b", ChangeType.Deleted),
        state("/w/c", ChangeType.Checkedout),
        state("/w/d", ChangeType.Changed),
      ]);
    expect(paths).to.eql([ "/w/d", "/w/e" ]);
  });
});

describe("Locks section", () => {
  it("groups Mine before Others, sorted by path, and leaves empty groups out", () => {
    const groups = groupLocks([ lock("/b", "x", false), lock("/z", "me", true), lock("/a", "me", true) ]);
    expect(groups.map(g => [ g.id, g.label, g.locks.map(l => l.path) ])).to.eql([
      [ "mine", "Mine", [ "/a", "/z" ]],
      [ "others", "Others", ["/b"]],
    ]);
    expect(groupLocks([lock("/b", "x", false)]).map(g => g.id)).to.eql(["others"]);
    expect(groupLocks([])).to.eql([]);
  });

  it("loads the groups through the workspace's lock store", async () => {
    const entries = [ lock("/a", "me", true), lock("/b", "x", false) ];
    const workspace = {
      info: { id: "w", name: "Nimbus", path: "/w" },
      locks: { refresh: () => Promise.resolve({ entries }) as never },
      onDidRunStatus: () => ({ dispose: () => undefined }),
      shell: undefined as never,
    };
    const page = await locksSection.load(workspace as never, { limit: 50 });
    expect(page.hasMore).to.equal(false);
    expect(page.items.map(g => g.id)).to.eql([ "mine", "others" ]);
    expect(await locksSection.loadChildren!(page.items[1], workspace as never)).to.eql([entries[1]]);
  });

  it("shows path, owner, branch and status, and sets a context for each side", () => {
    const others = lockItem(lock("/Assets/a.txt", "other@example.com", false));
    expect(others.label).to.equal("/Assets/a.txt");
    expect(others.description).to.equal("other@example.com · /main/task1 · Locked");
    expect(others.contextValue).to.equal(REPOSITORY_CONTEXT.lockOthers);

    const mine = lockItem(lock("/Assets/a.txt", "me", true));
    expect(mine.description).to.equal("/main/task1 · Locked");
    expect(mine.contextValue).to.equal(REPOSITORY_CONTEXT.lockMine);
  });

  it("explains the lock in the tooltip", () => {
    expect(lockTooltip({ ...lock("/a", "me", true), destinationBranch: "/main/x" }))
      .to.contain("Branch: /main/task1 (released on /main/x)");
  });

  it("builds a group row with a count", () => {
    const [group] = groupLocks([lock("/a", "me", true)]);
    expect(locksSection.toTreeItem(group, undefined as never).label).to.equal("Mine (1)");
    expect(locksSection.toTreeItem(group, undefined as never).contextValue).to.equal(REPOSITORY_CONTEXT.lockGroup);
  });
});

describe("lockNodesFromArgs", () => {
  const node = (entry: ILockEntry, section = "locks") => ({
    child: entry,
    kind: "child",
    parent: { kind: "item", parent: { section: { id: section }}},
    workspace: { info: { id: "w1" }},
  });

  it("reads the clicked lock node", () => {
    const nodes = lockNodesFromArgs([node(lock("/a", "me", true))]);
    expect(nodes.map(n => [ n.lock.path, n.workspaceId ])).to.eql([[ "/a", "w1" ]]);
  });

  it("uses the selection when there is one, without duplicates", () => {
    const a = node(lock("/a", "me", true));
    const b = node(lock("/b", "x", false));
    expect(lockNodesFromArgs([ a, [ a, b, a ]]).map(n => n.lock.path)).to.eql([ "/a", "/b" ]);
  });

  it("ignores rows of other sections and other things", () => {
    expect(lockNodesFromArgs([node(lock("/a", "me", true), "shelves")])).to.eql([]);
    expect(lockNodesFromArgs([ undefined, "x" ])).to.eql([]);
    expect(lockNodesFromArgs([])).to.eql([]);
  });
});
