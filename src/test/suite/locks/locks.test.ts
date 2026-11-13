import { buildEntries, lockKey, LockSnapshot, repositoryMatches } from "../../../locks/lockSnapshot";
import { decorateLocked, describeLock, LOCK_BADGE_MINE, LOCK_BADGE_OTHERS } from "../../../locks/lockDecoration";
import { explainCheckoutFailure, lockItemSpec, locksHeldByOthers } from "../../../locks/lockMessages";
import { ILockEntry, ILockInfo } from "../../../models";
import { LOCK_REFRESH_INTERVAL_MILLIS, LockStore } from "../../../locks/lockStore";
import { expect } from "chai";
import { FileDecoration } from "vscode";
import { mockShellAnswering } from "../cm/commands/findChangesets/shellMock";

function info(path: string, owner: string, guid: string, extra: Partial<ILockInfo> = {}): ILockInfo {
  return {
    date: "2026-03-02 10:15:00",
    destinationBranch: "/main",
    destinationRevisionId: 1,
    guid,
    holderBranch: "/main/task1",
    holderRevisionId: 2,
    itemId: Number(guid.replace(/\D/g, "")) || 1,
    owner,
    path,
    repository: "Nimbus/Nimbus",
    status: "Locked",
    workspace: "NIMBUS-WK",
    ...extra,
  };
}

function entry(path: string, owner: string, mine: boolean, extra: Partial<ILockInfo> = {}): ILockEntry {
  return { ...info(path, owner, "g1", extra), mine };
}

describe("Lock snapshot", () => {
  it("matches the lock repository against the workspace's", () => {
    expect(repositoryMatches("Nimbus/Nimbus", "Nimbus/Nimbus@acme-studio@unity")).to.equal(true);
    expect(repositoryMatches("nimbus/nimbus", "Nimbus/Nimbus@acme-studio@unity")).to.equal(true);
    expect(repositoryMatches("Other/Other", "Nimbus/Nimbus@acme-studio@unity")).to.equal(false);
    expect(repositoryMatches("Other/Other", undefined)).to.equal(true);
    expect(repositoryMatches("Other/Other", "unknown@unknown")).to.equal(true);
  });

  it("keeps the repository's locks and marks the current user's", () => {
    const all = [
      info("/a.txt", "me@example.com", "g1"),
      info("/b.txt", "other@example.com", "g2"),
      info("/c.txt", "other@example.com", "g3", { repository: "Other/Other" }),
    ];
    const entries = buildEntries(all, [all[0]], "Nimbus/Nimbus@acme-studio@unity");
    expect(entries.map(e => [ e.path, e.mine ])).to.eql([[ "/a.txt", true ], [ "/b.txt", false ]]);
  });

  it("does not mark another lock of the same item as yours", () => {
    const mine = info("/a.txt", "me", "g1", { destinationBranch: "/main" });
    const other = info("/a.txt", "other", "g1", { destinationBranch: "/main/release" });
    const entries = buildEntries([ mine, other ], [mine], "Nimbus/Nimbus@acme-studio@unity");
    expect(entries.map(e => e.mine)).to.eql([ true, false ]);
    expect(lockKey(mine)).to.not.equal(lockKey(other));
  });

  it("finds a lock by workspace file, ignoring case and separators", () => {
    const snapshot = new LockSnapshot([entry("/Assets/Hero.FBX", "me", true)]);
    expect(snapshot.forFile("/work/Nimbus", "/work/Nimbus/assets/hero.fbx")?.owner).to.equal("me");
    expect(snapshot.forFile("/work/Nimbus", "/work/Nimbus/Assets/other.fbx")).to.equal(undefined);
    expect(snapshot.forFile("/work/Nimbus", "/elsewhere/Assets/Hero.FBX")).to.equal(undefined);
    expect(snapshot.forServerPath("/assets/hero.fbx")).to.not.equal(undefined);
  });

  it("prefers a held lock over a retained one on the same path", () => {
    const snapshot = new LockSnapshot([
      entry("/a.txt", "x", false, { status: "Retained" }),
      entry("/a.txt", "y", false, { status: "Locked" }),
    ]);
    expect(snapshot.forServerPath("/a.txt")?.owner).to.equal("y");
  });

  it("lists server paths with their original case", () => {
    expect(new LockSnapshot([entry("/Assets/A.txt", "x", false)]).serverPaths()).to.eql(["/Assets/A.txt"]);
  });
});

describe("LockStore", () => {
  function store(now: { value: number }, failing = false) {
    const logs: string[] = [];
    const all = [ info("/a.txt", "me", "g1"), info("/b.txt", "other", "g2") ];
    const shell = mockShellAnswering<ILockInfo[]>(call => failing
      ? { error: new Error("lock.conf missing"), success: false }
      : { result: call.args.includes("--onlycurrentuser") ? [all[0]] : all, success: true });
    const lockStore = new LockStore({
      log: message => logs.push(message),
      repSpec: () => "Nimbus/Nimbus@acme-studio@unity",
      shell: shell.mock.object,
    }, () => now.value);
    return { calls: shell.calls, lockStore, logs };
  }

  it("lists all locks and the user's, and fires a change", async () => {
    const { calls, lockStore } = store({ value: 0 });
    let fired = 0;
    lockStore.onDidChange(() => fired++);
    const snapshot = await lockStore.refresh();
    expect(snapshot.entries.map(e => [ e.path, e.mine ])).to.eql([[ "/a.txt", true ], [ "/b.txt", false ]]);
    expect(calls).to.have.length(2);
    expect(fired).to.equal(1);
  });

  it("does not list again within a minute when only asked for the badges, but does on explicit refresh", async () => {
    const now = { value: 1000 };
    const { calls, lockStore } = store(now);
    await lockStore.refreshIfStale();
    await lockStore.refreshIfStale();
    now.value += LOCK_REFRESH_INTERVAL_MILLIS - 1;
    await lockStore.refreshIfStale();
    expect(calls).to.have.length(2);

    await lockStore.refresh();
    expect(calls).to.have.length(4);

    now.value += LOCK_REFRESH_INTERVAL_MILLIS + 1;
    await lockStore.refreshIfStale();
    expect(calls).to.have.length(6);
  });

  it("asks for the workspace's repository only", async () => {
    const { calls, lockStore } = store({ value: 0 });
    await lockStore.refresh();
    calls.forEach(call => expect(call.args).to.include("--repository=Nimbus/Nimbus@acme-studio@unity"));
  });

  it("starts a new run for a fresh refresh while another is in flight", async () => {
    const { calls, lockStore } = store({ value: 0 });
    await Promise.all([ lockStore.refresh(), lockStore.refresh({ fresh: true }), lockStore.refresh({ fresh: true }) ]);
    expect(calls).to.have.length(4);
  });

  it("stops refreshing for the badges after a failure until an explicit refresh succeeds", async () => {
    const now = { value: 0 };
    const { calls, lockStore } = store(now, true);
    await lockStore.refreshIfStale();
    now.value += LOCK_REFRESH_INTERVAL_MILLIS * 10;
    await lockStore.refreshIfStale();
    expect(calls).to.have.length(1);
  });

  it("shares one run between concurrent refreshes", async () => {
    const { calls, lockStore } = store({ value: 0 });
    await Promise.all([ lockStore.refresh(), lockStore.refresh() ]);
    expect(calls).to.have.length(2);
  });

  it("logs a failure for the badges, never throws, and waits a minute before trying again", async () => {
    const now = { value: 0 };
    const { calls, lockStore, logs } = store(now, true);
    await lockStore.refreshIfStale();
    await lockStore.refreshIfStale();
    expect(calls).to.have.length(1);
    expect(logs[0]).to.contain("lock.conf missing");
  });

  it("rejects an explicit refresh when cm fails", async () => {
    const { lockStore } = store({ value: 0 }, true);
    let message = "";
    try {
      await lockStore.refresh();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.equal("lock.conf missing");
  });
});

describe("Lock messages", () => {
  const snapshot = new LockSnapshot([
    entry("/Assets/a.txt", "other@example.com", false, { holderBranch: "/main/task7", workspace: "OTHER-WK" }),
    entry("/Assets/mine.txt", "me@example.com", true),
  ]);

  it("finds only the files locked by somebody else", () => {
    const files = [ "/work/Nimbus/Assets/a.txt", "/work/Nimbus/Assets/mine.txt" ];
    const held = locksHeldByOthers(snapshot, "/work/Nimbus", files);
    expect(held.map(h => h.fsPath)).to.eql(["/work/Nimbus/Assets/a.txt"]);
  });

  it("names the holder, the workspace and the branch ahead of cm's message", () => {
    const held = locksHeldByOthers(snapshot, "/work/Nimbus", ["/work/Nimbus/Assets/a.txt"]);
    const message = explainCheckoutFailure("cm failed", held, "/work/Nimbus");
    expect(message).to.equal(
      "Assets/a.txt is locked by other@example.com (workspace OTHER-WK, branch /main/task7). cm failed");
  });

  it("leaves cm's message alone when nobody is known to hold the files", () => {
    expect(explainCheckoutFailure("cm failed", [], "/work/Nimbus")).to.equal("cm failed");
  });

  it("summarises many holders", () => {
    const many = Array.from({ length: 7 }, (_, i) => (
      { fsPath: `/w/f${i}.txt`, lock: entry(`/f${i}.txt`, "x", false) }));
    expect(explainCheckoutFailure("cm failed", many, "/w")).to.contain("and 2 more locked by others");
  });

  it("builds the item spec from the item id and the repository, or from the path", () => {
    const lock = { ...entry("/Assets/a.txt", "x", false), itemId: 812 };
    expect(lockItemSpec(lock, "Nimbus/Nimbus@acme-studio@unity", "/work/Nimbus"))
      .to.equal("itemid:812@Nimbus/Nimbus@acme-studio@unity");
    expect(lockItemSpec(lock, "unknown@unknown", "/work/Nimbus/")).to.equal("item:/work/Nimbus/Assets/a.txt");
    expect(lockItemSpec(lock, undefined, "/work/Nimbus")).to.equal("item:/work/Nimbus/Assets/a.txt");
  });
});

describe("Lock decorations", () => {
  const status = new FileDecoration("C", "Changed");

  it("badges a file locked by somebody else, over its change badge", () => {
    const decoration = decorateLocked(entry("/a.txt", "other@example.com", false), status);
    expect(decoration.badge).to.equal(LOCK_BADGE_OTHERS);
    expect(decoration.tooltip).to.contain("Changed");
    expect(decoration.tooltip).to.contain("Locked by other@example.com");
    expect(decoration.propagate).to.equal(false);
  });

  it("badges an unchanged file locked by you", () => {
    const decoration = decorateLocked(entry("/a.txt", "me", true), undefined);
    expect(decoration.badge).to.equal(LOCK_BADGE_MINE);
    expect(decoration.tooltip).to.equal("Locked by you (workspace NIMBUS-WK)");
  });

  it("keeps the change badge of a checked out file that you also lock, and adds the lock to the tooltip", () => {
    const decoration = decorateLocked(entry("/a.txt", "me", true), new FileDecoration("CO", "Checked Out"));
    expect(decoration.badge).to.equal("CO");
    expect(decoration.tooltip).to.equal("Checked Out · Locked by you (workspace NIMBUS-WK)");
  });

  it("says a retained lock is retained", () => {
    expect(describeLock(entry("/a.txt", "x", false, { status: "Retained" }))).to.contain("Retained lock by x");
  });
});
