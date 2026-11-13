import { buildExplorerModel, ExplorerScope, toFlatExplorerRow } from "../../../explorer/explorerGraph";
import { Disposable, Uri, ViewColumn, Webview, WebviewPanel, window } from "vscode";
import { IHistoryChangeset, RevisionType } from "../../../models";
import { expect } from "chai";
import { IExplorerStateMessage } from "../../../explorer/branchExplorerPanel";
import { IFileRow } from "../../../history/historyViewProvider";
import { join } from "path";

/** `out/test/suite/explorer` is four levels below the extension root. */
const EXTENSION_ROOT = join(__dirname, "..", "..", "..", "..");
const MEDIA = Uri.file(join(EXTENSION_ROOT, "media", "explorer"));
const LOAD_TIMEOUT_MILLIS = 30000;

type ProbeResolver = (value: unknown) => void;

interface IRowDump {
  readonly id: number;
  readonly text: string;
  readonly selected: boolean;
  readonly current: boolean;
  readonly refs: string[];
  readonly lines: number;
  readonly dashed: number;
  readonly context: Record<string, unknown>;
}

interface IFileDump {
  readonly text: string;
  readonly context: Record<string, unknown>;
}

interface IDump {
  readonly rows: IRowDump[];
  readonly footer: string;
  readonly banner: string;
  readonly bannerIsError: boolean;
  readonly count: string;
  readonly scope: string;
  readonly authors: string[];
  readonly details: string;
  readonly files: IFileDump[];
  readonly graphWidth: string;
}

/**
 * The client is a plain script meant for a webview, so it is exercised in a real
 * one: a probe script loaded before it shares the single `acquireVsCodeApi`
 * instance, answers `dump` with a snapshot of the DOM and drives the controls
 * with real events.
 */
const PROBE = `
  const api = acquireVsCodeApi();
  window.acquireVsCodeApi = () => api;

  // Text nodes joined with a space, so neighbouring cells do not run together.
  function textOf(el) {
    if (!el) {
      return "";
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts = [];
    while (walker.nextNode()) {
      parts.push(walker.currentNode.nodeValue || "");
    }
    return parts.join(" ").replace(/\\s+/g, " ").trim();
  }
  const contextOf = el => JSON.parse(el.dataset.vscodeContext || "{}");

  function dump() {
    const rows = Array.from(document.querySelectorAll(".row:not(.footer)")).map(row => ({
      context: contextOf(row),
      current: row.classList.contains("current"),
      dashed: row.querySelectorAll("svg .line.merge").length,
      id: Number(row.dataset.id),
      lines: row.querySelectorAll("svg .line").length,
      refs: Array.from(row.querySelectorAll(".ref:not(.home)")).map(textOf),
      selected: row.classList.contains("selected"),
      text: textOf(row),
    }));
    const banner = document.querySelector(".banner");
    return {
      authors: Array.from(document.querySelectorAll(".toolbar select")[1].options).map(option => option.value),
      banner: banner.classList.contains("shown") ? textOf(banner) : "",
      bannerIsError: banner.classList.contains("error"),
      count: textOf(document.querySelector(".toolbar .count")),
      details: textOf(document.querySelector(".details-info")),
      files: Array.from(document.querySelectorAll(".details-files .file"))
        .map(file => ({ context: contextOf(file), text: textOf(file) })),
      footer: textOf(document.querySelector(".row.footer")),
      graphWidth: document.querySelector(".list").style.getPropertyValue("--graph-width"),
      rows,
      scope: document.querySelectorAll(".toolbar select")[0].value,
    };
  }

  function click(selector, index) {
    const target = document.querySelectorAll(selector)[index || 0];
    if (!target) {
      return "nothing matches " + selector;
    }
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return "clicked";
  }

  function clickText(selector, text) {
    const target = Array.from(document.querySelectorAll(selector)).find(el => textOf(el) === text);
    if (!target) {
      return "no " + selector + " says " + text;
    }
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return "clicked";
  }

  function setValue(selector, index, value, eventName) {
    const target = document.querySelectorAll(selector)[index];
    if (!target) {
      return "nothing matches " + selector;
    }
    target.value = value;
    target.dispatchEvent(new Event(eventName, { bubbles: true }));
    return "set";
  }

  window.addEventListener("message", event => {
    const message = event.data;
    if (!message || typeof message !== "object" || typeof message.probe !== "string") {
      return;
    }
    let value;
    switch (message.probe) {
    case "dump": value = dump(); break;
    case "click": value = click(message.selector, message.index); break;
    case "clickText": value = clickText(message.selector, message.text); break;
    case "setValue": value = setValue(message.selector, message.index, message.value, message.event); break;
    default: return;
    }
    api.postMessage({ id: message.id, probe: message.probe, value });
  });
`;

function html(webview: Webview): string {
  const script = webview.asWebviewUri(Uri.joinPath(MEDIA, "explorer.js")).toString();
  const style = webview.asWebviewUri(Uri.joinPath(MEDIA, "explorer.css")).toString();
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
  private readonly mPending: Map<number, ProbeResolver> = new Map<number, ProbeResolver>();
  private mNextId = 1;
  private mReady?: () => void;

  public constructor() {
    this.mPanel = window.createWebviewPanel(
      "plasticScmExplorerTest",
      "Explorer client test",
      { preserveFocus: true, viewColumn: ViewColumn.One },
      { enableScripts: true, localResourceRoots: [MEDIA] });

    this.readyPromise = new Promise<void>(resolve => {
      this.mReady = resolve;
    });

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
    await settle();
  }

  public async probe<T>(probe: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = this.mNextId++;
    const answer = new Promise<T>(resolve => {
      this.mPending.set(id, value => resolve(value as T));
    });
    void this.mPanel.webview.postMessage({ id, probe, ...extra });
    const value = await answer;
    await settle();
    return value;
  }

  public dump(): Promise<IDump> {
    return this.probe<IDump>("dump");
  }

  public click(selector: string, index = 0): Promise<string> {
    return this.probe<string>("click", { index, selector });
  }

  public clickText(selector: string, text: string): Promise<string> {
    return this.probe<string>("clickText", { selector, text });
  }

  public setValue(selector: string, index: number, value: string, event: "input" | "change"): Promise<string> {
    return this.probe<string>("setValue", { event, index, selector, value });
  }

  public sent(type: string): Array<Record<string, unknown>> {
    return this.outbound.filter(message => message.type === type);
  }
}

/** A message posted by the client takes a turn of the event loop to arrive. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 60));
}

const WK_ID = "wk1";
const MAIN = "/main";
const TASK = "/main/task";
const DANA = "dana.kim@example.com";
const LEE = "lee.park@example.com";

function cs(id: number, parentId: number, branch: string, owner: string, comment: string): IHistoryChangeset {
  return {
    branch,
    comment,
    date: new Date(Date.UTC(2026, 8, 1, 10, id)),
    guid: `cafe${String(id).padStart(4, "0")}-4b1d-4c2e-9d3f-5a6b7c8d9e0f`,
    id,
    owner,
    parentId,
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
  };
}

const HISTORY = [
  cs(1, -1, MAIN, DANA, "Initial import"),
  cs(2, 1, MAIN, DANA, "Add the lobby scene"),
  cs(3, 2, TASK, LEE, "Rework the garage menu\nSecond line"),
  cs(4, 2, MAIN, DANA, "Tune the tyre model"),
  cs(5, 4, MAIN, DANA, "Merge the garage menu"),
];

function state(overrides: Partial<IExplorerStateMessage> = {}, scope: ExplorerScope = { kind: "all" }):
    IExplorerStateMessage {
  return {
    currentBranch: MAIN,
    currentChangesetId: 5,
    hasMore: false,
    loadingMore: false,
    model: buildExplorerModel({
      changesets: HISTORY,
      currentBranch: MAIN,
      currentChangesetId: 5,
      labels: [{
        branch: MAIN,
        changesetId: 2,
        comment: "",
        date: new Date(Date.UTC(2026, 8, 2)),
        id: 9002,
        name: "v1.0",
        owner: DANA,
        repository: "Nimbus/Nimbus",
        server: "acme-studio@unity",
      }],
      merges: [{
        destinationBranch: MAIN, destinationChangesetId: 5, sourceBranch: TASK, sourceChangesetId: 3, type: "merge",
      }],
      scope,
    }),
    scope,
    status: "ready",
    type: "state",
    workspaceId: WK_ID,
    workspaceName: "nimbus",
    ...overrides,
  };
}

function fileRow(path: string, canDiff = true): IFileRow {
  const slash = path.lastIndexOf("/");
  return {
    canDiff,
    directory: path.substring(1, slash),
    name: path.substring(slash + 1),
    path,
    reason: canDiff ? undefined : "Binary files cannot be compared.",
    revisionId: 700 + path.length,
    revisionType: canDiff ? RevisionType.TextFile : RevisionType.BinaryFile,
    status: "C",
    statusTooltip: "Changed",
  };
}

describe("Branch Explorer client", function() {
  this.timeout(LOAD_TIMEOUT_MILLIS + 10000);

  let client: ClientHarness;

  beforeEach(async () => {
    client = new ClientHarness();
    await client.readyPromise;
  });

  afterEach(() => {
    client.dispose();
  });

  it("says it is ready and shows a loading note until the first state arrives", async () => {
    expect(client.sent("ready")).to.have.length(1);
    const dump = await client.dump();
    expect(dump.rows).to.eql([]);
    expect(dump.footer).to.equal("Loading changesets…");
  });

  it("lists every changeset newest first with its branch, author and number", async () => {
    await client.post(state());
    const dump = await client.dump();

    expect(dump.rows.map(row => row.id)).to.eql([ 5, 4, 3, 2, 1 ]);
    expect(dump.rows[2].text).to.contain("Rework the garage menu");
    expect(dump.rows[2].text).to.not.contain("Second line");
    expect(dump.rows[2].text).to.contain(TASK);
    expect(dump.rows[2].text).to.contain("lee.park");
    expect(dump.count).to.equal("5 loaded");
    expect(dump.footer).to.equal("Beginning of the history.");
    expect(dump.scope).to.equal("all");
  });

  it("draws branch and label pills, the workspace's row and a dashed merge line", async () => {
    await client.post(state());
    const dump = await client.dump();

    expect(dump.rows[0].refs).to.eql(["/main"]);
    expect(dump.rows[2].refs).to.eql(["task"]);
    expect(dump.rows[3].refs).to.eql(["v1.0"]);
    expect(dump.rows.filter(row => row.current).map(row => row.id)).to.eql([5]);
    expect(dump.rows[0].dashed).to.equal(1);
    expect(dump.rows[4].dashed).to.equal(0);
    expect(dump.rows.every(row => row.lines > 0)).to.equal(true);
    // Two lanes of 14px plus the margin.
    expect(dump.graphWidth).to.equal("38px");
  });

  it("gives each row the context its menu commands need", async () => {
    await client.post(state());
    const dump = await client.dump();

    expect(dump.rows[2].context).to.include({
      branch: TASK,
      changesetId: 3,
      explorerCanCompare: false,
      explorerIsWorkspaceChangeset: false,
      preventDefaultContextMenuItems: true,
      webviewSection: "explorerChangeset",
      wkId: WK_ID,
    });
    expect(dump.rows[0].context.explorerIsWorkspaceChangeset).to.equal(true);
  });

  it("asks for older changesets when the end of the list is in view", async () => {
    await client.post(state({ hasMore: true }));
    expect(client.sent("loadMore").length).to.be.greaterThan(0);
    expect((await client.dump()).footer).to.equal("Load older changesets");
  });

  it("does not ask again while a page is loading", async () => {
    await client.post(state({ hasMore: true, loadingMore: true }));
    expect(client.sent("loadMore")).to.have.length(0);
    expect((await client.dump()).footer).to.equal("Loading older changesets…");
  });

  it("filters the loaded rows as the user types, across comment, branch, author and number", async () => {
    await client.post(state());

    await client.setValue(".search-wrap input.search", 0, "GARAGE", "input");
    let dump = await client.dump();
    expect(dump.rows.map(row => row.id)).to.eql([ 5, 3 ]);
    expect(dump.count).to.equal("2 of 5 loaded");
    expect(dump.footer).to.equal("2 of the 5 loaded changesets match.");
    // A filtered list has no graph, only dots.
    expect(dump.rows.every(row => row.lines === 0)).to.equal(true);

    await client.setValue(".search-wrap input.search", 0, "garage lee.park", "input");
    expect((await client.dump()).rows.map(row => row.id)).to.eql([3]);

    await client.setValue(".search-wrap input.search", 0, "cs:4", "input");
    expect((await client.dump()).rows.map(row => row.id)).to.eql([4]);

    await client.setValue(".search-wrap input.search", 0, "v1.0", "input");
    expect((await client.dump()).rows.map(row => row.id)).to.eql([2]);

    await client.setValue(".search-wrap input.search", 0, "", "input");
    dump = await client.dump();
    expect(dump.rows.map(row => row.id)).to.eql([ 5, 4, 3, 2, 1 ]);
    expect(dump.rows.every(row => row.lines > 0)).to.equal(true);
  });

  it("does not page automatically while a filter is on", async () => {
    await client.post(state());
    await client.setValue(".search-wrap input.search", 0, "garage", "input");
    await client.post(state({ hasMore: true }));

    expect(client.sent("loadMore")).to.have.length(0);
    await client.clickText(".row.footer button", "Load older changesets");
    expect(client.sent("loadMore")).to.have.length(1);
  });

  it("filters by author", async () => {
    await client.post(state());
    const before = await client.dump();
    expect(before.authors).to.eql([ "", DANA, LEE ]);

    await client.setValue(".toolbar select", 1, LEE, "change");
    const dump = await client.dump();
    expect(dump.rows.map(row => row.id)).to.eql([3]);
    expect(dump.count).to.equal("1 of 5 loaded");
  });

  it("posts the scope the user picks and follows the scope the extension answers with", async () => {
    await client.post(state());
    await client.setValue(".toolbar select", 0, "current", "change");
    expect(client.sent("scope")).to.eql([{ scope: { kind: "current" }, type: "scope" }]);

    await client.setValue(".toolbar select", 0, "branches", "change");
    expect(client.sent("scope")[1]).to.eql({ scope: { branches: [MAIN], kind: "branches" }, type: "scope" });

    const scope: ExplorerScope = { branches: [TASK], kind: "branches" };
    await client.post(state({}, scope));
    const dump = await client.dump();
    expect(dump.scope).to.equal("branches");
    expect(dump.rows.map(row => row.id)).to.eql([3]);
    expect(dump.count).to.equal("1 of 5 loaded");
  });

  it("lists the loaded branches to pick from and posts every tick", async () => {
    await client.post(state());
    await client.setValue(".toolbar select", 0, "branches", "change");
    await client.post(state({}, { branches: [MAIN], kind: "branches" }));

    await client.click(".branch-list input", 1);
    expect(client.sent("scope").pop()).to.eql({ scope: { branches: [ MAIN, TASK ], kind: "branches" }, type: "scope" });

    await client.clickText(".branch-menu button", "Clear");
    expect(client.sent("scope").pop()).to.eql({ scope: { branches: [], kind: "branches" }, type: "scope" });
  });

  it("selects a row on click, shows its details and asks for its files once", async () => {
    await client.post(state());
    await client.click(".row:not(.footer)", 0);

    const dump = await client.dump();
    expect(dump.rows.filter(row => row.selected).map(row => row.id)).to.eql([5]);
    expect(dump.details).to.contain("cs:5");
    expect(dump.details).to.contain(DANA);
    expect(dump.details).to.contain("Parent cs:4");
    expect(dump.details).to.contain(`Merged from cs:3 ${TASK}`);
    expect(dump.details).to.contain("Merge the garage menu");
    expect(client.sent("files")).to.eql([{ changesetId: 5, type: "files" }]);

    await client.post(state());
    expect(client.sent("files")).to.have.length(1);
  });

  it("lists the files of the selected changeset and opens a diff on click", async () => {
    await client.post(state());
    await client.click(".row:not(.footer)", 2);
    const files = [ fileRow("/Assets/Menus/Garage.cs"), fileRow("/Assets/Art/garage.png", false) ];
    await client.post({ changesetId: 3, files, type: "files" });

    let dump = await client.dump();
    expect(dump.files.map(file => file.text)).to.eql([ "C Garage.cs Assets/Menus", "C garage.png Assets/Art" ]);
    expect(dump.files[0].context).to.include({
      changesetId: 3, path: "/Assets/Menus/Garage.cs", webviewSection: "explorerFile", wkId: WK_ID,
    });

    await client.click(".details-files .file", 0);
    await client.click(".details-files .file", 1);
    expect(client.sent("openDiff")).to.eql([{
      changesetId: 3, path: "/Assets/Menus/Garage.cs", revisionId: files[0].revisionId, type: "openDiff",
    }]);

    await client.setValue(".details-files input.search", 0, "art", "input");
    dump = await client.dump();
    expect(dump.files.map(file => file.text)).to.eql(["C garage.png Assets/Art"]);
  });

  it("ignores the files of a changeset that is no longer selected", async () => {
    await client.post(state());
    await client.click(".row:not(.footer)", 2);
    await client.click(".row:not(.footer)", 1);
    await client.post({ changesetId: 3, files: [fileRow("/Assets/Menus/Garage.cs")], type: "files" });

    expect((await client.dump()).files).to.eql([]);
  });

  it("says why the files could not be loaded and retries", async () => {
    await client.post(state());
    await client.click(".row:not(.footer)", 1);
    await client.post({ changesetId: 4, message: "The server is not reachable.", type: "filesError" });

    expect(await client.clickText(".details-files button", "Retry")).to.equal("clicked");
    expect(client.sent("files")).to.eql([{ changesetId: 4, type: "files" }, { changesetId: 4, type: "files" }]);
  });

  it("offers to compare a row with the selected one", async () => {
    await client.post(state());
    await client.click(".row:not(.footer)", 4);

    const dump = await client.dump();
    expect(dump.rows[0].context).to.include({ compareWithId: 1, explorerCanCompare: true });
    expect(dump.rows[4].context).to.include({ explorerCanCompare: false });
  });

  it("jumps to the parent from the details", async () => {
    await client.post(state());
    await client.click(".row:not(.footer)", 0);
    await client.clickText(".details-info button", "cs:4");

    const dump = await client.dump();
    expect(dump.rows.filter(row => row.selected).map(row => row.id)).to.eql([4]);
    expect(dump.details).to.contain("cs:4");
  });

  it("searches the whole repository and lists the answer without a graph", async () => {
    await client.post(state());
    await client.setValue(".search-wrap input.search", 0, "  tyre  ", "input");
    await client.clickText(".toolbar button", "Search repository");

    expect(client.sent("search")).to.eql([{ text: "tyre", type: "search" }]);
    let dump = await client.dump();
    expect(dump.banner).to.contain("Searching the repository for “tyre”");
    expect(dump.rows).to.eql([]);

    const old = cs(900, 899, "/main/physics", LEE, "Old tyre experiment");
    await client.post({ rows: [toFlatExplorerRow(old, 5)], text: "tyre", type: "searchResults" });
    dump = await client.dump();
    expect(dump.rows.map(row => row.id)).to.eql([900]);
    expect(dump.rows[0].lines).to.equal(0);
    expect(dump.banner).to.contain("1 changeset.");

    await client.clickText(".banner button", "Back to the graph");
    dump = await client.dump();
    expect(dump.banner).to.equal("");
    expect(dump.rows.map(row => row.id)).to.eql([ 5, 4, 3, 2, 1 ]);
  });

  it("drops the answer of a search that was replaced", async () => {
    await client.post(state());
    await client.setValue(".search-wrap input.search", 0, "tyre", "input");
    await client.clickText(".toolbar button", "Search repository");
    await client.setValue(".search-wrap input.search", 0, "lobby", "input");
    await client.clickText(".toolbar button", "Search repository");
    await client.post({ rows: [toFlatExplorerRow(HISTORY[3], 5)], text: "tyre", type: "searchResults" });

    const dump = await client.dump();
    expect(dump.rows).to.eql([]);
    expect(dump.banner).to.contain("“lobby”");
  });

  it("reports a failed repository search", async () => {
    await client.post(state());
    await client.setValue(".search-wrap input.search", 0, "tyre", "input");
    await client.clickText(".toolbar button", "Search repository");
    await client.post({ message: "The query is not valid.", text: "tyre", type: "searchError" });

    const dump = await client.dump();
    expect(dump.bannerIsError).to.equal(true);
    expect(dump.banner).to.contain("The query is not valid.");
  });

  it("reports a failed load with a way to retry", async () => {
    await client.post(state({ message: "cm is not installed.", status: "error" }));
    const dump = await client.dump();
    expect(dump.bannerIsError).to.equal(true);
    expect(dump.banner).to.contain("cm is not installed.");

    await client.clickText(".banner button", "Retry");
    await client.clickText(".banner button", "Show Output");
    expect(client.sent("refresh")).to.have.length(1);
    expect(client.sent("showOutput")).to.have.length(1);
  });

  it("keeps the selection when the history is reloaded", async () => {
    await client.post(state());
    await client.click(".row:not(.footer)", 2);
    await client.post(state());

    const dump = await client.dump();
    expect(dump.rows.filter(row => row.selected).map(row => row.id)).to.eql([3]);
    expect(dump.details).to.contain("cs:3");
  });
});
