import { Disposable, Uri, ViewColumn, Webview, WebviewPanel, window } from "vscode";
import { IFileRow, IWorkspaceState } from "../../../history/historyViewProvider";
import { expect } from "chai";
import { IGraphModel } from "../../../history/graphModel";
import { join } from "path";
import { RevisionType } from "../../../models";

/** `out/test/suite/history` is four levels below the extension root. */
const EXTENSION_ROOT = join(__dirname, "..", "..", "..", "..");
const MEDIA = Uri.file(join(EXTENSION_ROOT, "media", "history"));
const LOAD_TIMEOUT_MILLIS = 30000;

type ProbeResolver = (value: unknown) => void;

/** What the probe script reports back about one rendered row. */
interface IRowDump {
  readonly kind: string;
  readonly key: string;
  readonly text: string;
  readonly path?: string;
  readonly rev?: string;
  readonly status?: string;
  readonly labels: string[];
  readonly disabled: boolean;
}

interface IDump {
  readonly rows: IRowDump[];
  readonly banner?: string;
  readonly bannerRole?: string;
  readonly bannerButtons: string[];
  readonly emptyState?: string;
  readonly progress: boolean;
  readonly links: number;
}

/**
 * The client is a plain script meant for a webview, so it is exercised in a real
 * one: a probe script loaded before it shares the single `acquireVsCodeApi`
 * instance, answers `dump` with a snapshot of the DOM, and dispatches real mouse
 * events for `click`.
 */
const PROBE = `
  const api = acquireVsCodeApi();
  window.acquireVsCodeApi = () => api;

  const textOf = el => (el.textContent || "").replace(/\\s+/g, " ").trim();

  function dump() {
    const root = document.getElementById("root");
    const rows = Array.from(root.querySelectorAll(".row")).map(row => ({
      disabled: row.classList.contains("disabled"),
      key: row.dataset.key || "",
      kind: row.dataset.kind || "",
      labels: Array.from(row.querySelectorAll(".label .label-text")).map(textOf),
      path: row.dataset.path,
      rev: row.dataset.rev,
      status: row.querySelector(".status") ? textOf(row.querySelector(".status")) : undefined,
      text: textOf(row),
    }));
    const banner = root.querySelector(".banner.error");
    return {
      banner: banner ? textOf(banner.querySelector(".message")) : undefined,
      bannerButtons: banner ? Array.from(banner.querySelectorAll("button")).map(textOf) : [],
      bannerRole: banner ? banner.getAttribute("role") || undefined : undefined,
      emptyState: root.querySelector(".empty-state") ? textOf(root.querySelector(".empty-state .message")) : undefined,
      links: root.querySelectorAll("svg.lanes .link").length,
      progress: !!root.querySelector(".progress"),
      rows,
    };
  }

  function clickRow(key) {
    const row = document.querySelector('.row[data-key="' + key + '"]');
    if (!row) {
      return "no such row: " + key;
    }
    const box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: box.left + box.width - 4,
      clientY: box.top + box.height / 2,
    }));
    return "clicked";
  }

  /**
   * The lane layer covers the rows, so every shape in it has to be transparent
   * to the pointer or it eats the row's click, hover and context menu.
   */
  function lanePointerEvents() {
    const shapes = Array.from(document.querySelectorAll("svg.lanes .link, svg.lanes .node, svg.lanes"));
    return {
      dashed: document.querySelectorAll("svg.lanes .link.dashed").length,
      values: Array.from(new Set(shapes.map(shape => getComputedStyle(shape).pointerEvents))),
    };
  }

  function rowTooltip(key) {
    const row = document.querySelector('.row[data-key="' + key + '"]');
    return row ? row.title : undefined;
  }

  window.addEventListener("message", event => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.probe) {
    case "dump":
      api.postMessage({ id: message.id, probe: "dump", value: dump() });
      return;
    case "clickRow":
      api.postMessage({ id: message.id, probe: "clickRow", value: clickRow(message.key) });
      return;
    case "lanePointerEvents":
      api.postMessage({ id: message.id, probe: "lanePointerEvents", value: lanePointerEvents() });
      return;
    case "rowTooltip":
      api.postMessage({ id: message.id, probe: "rowTooltip", value: rowTooltip(message.key) });
      return;
    default:
      return;
    }
  });
`;

function html(webview: Webview): string {
  const script = webview.asWebviewUri(Uri.joinPath(MEDIA, "history.js")).toString();
  const style = webview.asWebviewUri(Uri.joinPath(MEDIA, "history.css")).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    "script-src 'nonce-probe' 'nonce-client'",
  ].join("; ");

  return [
    "<!DOCTYPE html>",
    "<html lang=\"en\"><head><meta charset=\"UTF-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${csp};">`,
    `<link href="${style}" rel="stylesheet">`,
    "</head><body><div id=\"root\"></div>",
    `<script nonce="probe">${PROBE}</script>`,
    `<script nonce="client" src="${script}"></script>`,
    "</body></html>",
  ].join("\n");
}

/** Drives one webview: sends probes, and collects what the client posts out. */
class ClientHarness implements Disposable {
  public readonly outbound: Array<Record<string, unknown>> = [];
  public readonly readyPromise: Promise<void>;

  private readonly mPanel: WebviewPanel;
  private readonly mDisposable: Disposable;
  private readonly mPending = new Map<number, ProbeResolver>();
  private mNextId = 1;
  private mReady?: () => void;

  public constructor() {
    this.mPanel = window.createWebviewPanel(
      "plasticScmGraphTest",
      "Graph client test",
      { preserveFocus: true, viewColumn: ViewColumn.One },
      { enableScripts: true, localResourceRoots: [MEDIA] });

    const ready = new Promise<void>(resolve => {
      this.mReady = resolve;
    });
    this.readyPromise = ready;

    this.mDisposable = this.mPanel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      if (typeof message.probe === "string" && typeof message.id === "number") {
        this.mPending.get(message.id)?.(message.value);
        this.mPending.delete(message.id);
        return;
      }

      this.outbound.push(message);
      if (message.type === "ready") {
        this.mReady?.();
      }
    });

    this.mPanel.webview.html = html(this.mPanel.webview);
  }

  public dispose(): void {
    this.mDisposable.dispose();
    this.mPanel.dispose();
  }

  public async post(message: unknown): Promise<void> {
    await this.mPanel.webview.postMessage(message);
    // One render is scheduled synchronously by the client's message handler; a
    // turn of the event loop is enough for it to finish.
    await new Promise(resolve => setTimeout(resolve, 60));
  }

  public probe<T>(probe: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = this.mNextId++;
    const answer = new Promise<T>(resolve => {
      this.mPending.set(id, value => resolve(value as T));
    });
    void this.mPanel.webview.postMessage({ id, probe, ...extra });
    return answer;
  }

  public dump(): Promise<IDump> {
    return this.probe<IDump>("dump");
  }
}

const WK_ID = "wk1";

function model(): IGraphModel {
  return {
    currentLoaded: true,
    lanes: [
      { branch: "/main/task", count: 2, hasMore: false, hasNewer: false, kind: "current", loading: false },
      { branch: "/main", count: 1, hasMore: false, hasNewer: false, kind: "parent", loading: false },
    ],
    links: [
      { fromId: 20, kind: "parent", toId: 19 },
      { fromId: 20, kind: "merge", mergeType: "cherrypick", toId: 10 },
    ],
    rows: [
      {
        branch: "/main/task",
        comment: "Second on the task branch",
        date: "2026-09-01T10:00:00.000Z",
        id: 20,
        isCurrent: true,
        labels: [{ isCurrent: false, kind: "current", text: "/main/task" }],
        lane: 0,
        owner: "dana.kim@example.com",
        ownerShort: "dana.kim",
        parentId: 19,
        parentLane: 0,
        parentLoaded: true,
        subject: "Second on the task branch",
      },
      {
        branch: "/main/task",
        comment: "First on the task branch",
        date: "2026-08-30T10:00:00.000Z",
        id: 19,
        isCurrent: false,
        labels: [],
        lane: 0,
        owner: "someone.else@example.com",
        ownerShort: "someone.else",
        parentId: 10,
        parentLane: 1,
        parentLoaded: true,
        subject: "First on the task branch",
      },
      {
        branch: "/main",
        comment: "Branch point",
        date: "2026-08-01T10:00:00.000Z",
        id: 10,
        isCurrent: false,
        labels: [{ isCurrent: false, kind: "parent", text: "/main" }],
        lane: 1,
        owner: "build@example.com",
        ownerShort: "build",
        parentId: -1,
        parentLane: 1,
        parentLoaded: false,
        subject: "Branch point",
      },
    ],
  };
}

function workspace(overrides: Partial<IWorkspaceState> = {}): IWorkspaceState {
  return {
    currentBranch: "/main/task",
    currentChangesetId: 20,
    id: WK_ID,
    model: model(),
    name: "Nimbus",
    path: "/Users/me/Nimbus",
    status: "ready",
    ...overrides,
  };
}

/** A changeset that deletes a path and adds it back: two rows, one path. */
const DELETE_AND_READD: IFileRow[] = [
  {
    canDiff: true,
    directory: "Assets",
    name: "Foo.cs",
    path: "/Assets/Foo.cs",
    revisionId: 41,
    revisionType: RevisionType.TextFile,
    status: "D",
    statusTooltip: "Deleted",
  },
  {
    canDiff: true,
    directory: "Assets",
    name: "Foo.cs",
    path: "/Assets/Foo.cs",
    revisionId: 42,
    revisionType: RevisionType.TextFile,
    status: "A",
    statusTooltip: "Added",
  },
];

describe("Graph webview client", function() {
  // A real webview has to start up, which no unit test in this suite does.
  this.timeout(LOAD_TIMEOUT_MILLIS);

  let harness: ClientHarness;

  before(async () => {
    harness = new ClientHarness();
    await harness.readyPromise;
  });

  after(() => {
    harness?.dispose();
  });

  it("announces itself before any state arrives", () => {
    expect(harness.outbound.some(message => message.type === "ready")).to.be.true;
  });

  it("draws a row per changeset, with the branch labels and the lane links", async () => {
    await harness.post({ type: "state", workspaces: [workspace()] });
    const dump = await harness.dump();

    const changesets = dump.rows.filter(row => row.kind === "changeset");
    expect(changesets.map(row => row.key)).to.eql([ `${WK_ID}:20`, `${WK_ID}:19`, `${WK_ID}:10` ]);
    expect(changesets[0].labels).to.eql(["/main/task"]);
    expect(changesets[2].labels).to.eql(["/main"]);
    expect(dump.links).to.equal(2);
    expect(dump.banner).to.be.undefined;
    expect(dump.progress).to.be.false;
  });

  it("keeps the rows and explains itself when a reload fails", async () => {
    await harness.post({
      type: "state",
      workspaces: [workspace({ message: "cm find changeset failed: connection refused", status: "error" })],
    });
    const dump = await harness.dump();

    expect(dump.banner).to.equal("cm find changeset failed: connection refused");
    expect(dump.bannerRole).to.equal("alert");
    expect(dump.bannerButtons).to.eql([ "Show Output", "Retry" ]);
    expect(dump.rows.filter(row => row.kind === "changeset")).to.have.length(3);
  });

  it("announces a failure once, not on every state message it survives", async () => {
    // A message the earlier test did not use: the client remembers what it has
    // already announced for a workspace, which is the behaviour under test.
    const failing = workspace({ message: "cm find changeset failed: server is upgrading", status: "error" });
    await harness.post({ type: "state", workspaces: [failing] });
    expect((await harness.dump()).bannerRole, "the first render announces").to.equal("alert");

    await harness.post({ type: "state", workspaces: [failing] });
    const second = await harness.dump();

    expect(second.banner, "the banner stays").to.equal(failing.message);
    expect(second.bannerRole, "a live region that reappears is read out again").to.be.undefined;
  });

  it("shows the progress bar while a reload is in flight", async () => {
    await harness.post({ type: "state", workspaces: [workspace({ status: "loading" })] });
    const dump = await harness.dump();

    expect(dump.progress).to.be.true;
    expect(dump.banner).to.be.undefined;
  });

  it("leaves the whole lane layer transparent to the pointer, links included", async () => {
    await harness.post({ type: "state", workspaces: [workspace()] });
    const lanes = await harness.probe<{ dashed: number; values: string[] }>("lanePointerEvents");

    // The cherry-pick link is the one that used to take the pointer for its
    // tooltip, so the fixture has to contain one for this to mean anything.
    expect(lanes.dashed, "the fixture must draw a dashed link").to.be.greaterThan(0);
    expect(lanes.values).to.eql(["none"]);
  });

  it("puts what a cherry-pick link means into the tooltip of the row it lands on", async () => {
    await harness.post({ type: "state", workspaces: [workspace()] });

    expect(await harness.probe<string>("rowTooltip", { key: `${WK_ID}:20` }))
      .to.contain("Cherry-picked from cs:10");
  });

  it("tells the two rows of a delete and re-add pair apart by revision", async () => {
    await harness.post({ type: "state", workspaces: [workspace()] });
    await harness.post({ changesetId: 20, files: DELETE_AND_READD, type: "files", wkId: WK_ID });
    await harness.probe<string>("clickRow", { key: `${WK_ID}:20` });
    await harness.post({ changesetId: 20, files: DELETE_AND_READD, type: "files", wkId: WK_ID });

    const dump = await harness.dump();
    const files = dump.rows.filter(row => row.kind === "file");
    expect(files.map(row => row.rev)).to.eql([ "41", "42" ]);
    expect(new Set(files.map(row => row.key)).size).to.equal(2);
    expect(files.map(row => row.status)).to.eql([ "D", "A" ]);
  });

  it("names the revision when a file row is opened, so the right side of the pair is diffed", async () => {
    const before = harness.outbound.length;

    await harness.probe<string>("clickRow", { key: `${WK_ID}:20:/Assets/Foo.cs:42` });
    await new Promise(resolve => setTimeout(resolve, 60));

    const opened = harness.outbound.slice(before).filter(message => message.type === "openDiff");
    expect(opened).to.have.length(1);
    expect(opened[0].path).to.equal("/Assets/Foo.cs");
    expect(opened[0].revisionId).to.equal(42);
    expect(opened[0].changesetId).to.equal(20);
  });

  it("asks again for a file list that failed, once the graph starts reloading", async () => {
    await harness.post({ type: "state", workspaces: [workspace()] });
    // A changeset no earlier test has expanded: the toggle is stateful.
    await harness.probe<string>("clickRow", { key: `${WK_ID}:19` });
    await harness.post({ changesetId: 19, message: "cm diff failed", type: "filesError", wkId: WK_ID });
    expect((await harness.dump()).rows.some(row => row.text.includes("cm diff failed")),
      "the failure is shown under the changeset").to.be.true;

    const before = harness.outbound.length;
    await harness.post({ type: "state", workspaces: [workspace({ status: "loading" })] });

    const asked = harness.outbound.slice(before)
      .filter(message => message.type === "files" && message.changesetId === 19);
    expect(asked, "a reload is the moment to retry it").to.have.length(1);
  });

  it("says so when there is no workspace at all", async () => {
    await harness.post({ type: "state", workspaces: [] });
    const dump = await harness.dump();

    expect(dump.emptyState).to.equal("No Plastic SCM workspace in this window.");
    expect(dump.rows).to.have.length(0);
  });
});
