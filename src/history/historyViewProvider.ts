import {
  CancellationToken,
  commands,
  Disposable,
  Uri,
  Webview,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  window,
} from "vscode";
import { describeError, showOperationError } from "../commands/scmUtils";
import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../models";
import { HistoryStatus, WorkspaceHistory } from "./workspaceHistory";
import { IConfig } from "../config";
import { IGraphModel } from "./graphModel";
import { openChangesetFileDiff } from "./openChangesetFileDiff";
import { PlasticScm } from "../plasticScm";
import { posix } from "path";
import { randomBytes } from "crypto";
import { WorkspaceOperation } from "../workspaceOperations";

export const historyViewId = "plastic-scm.history";

/** Everything the client needs to draw one workspace; sent whole on every change. */
export interface IWorkspaceState {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly status: HistoryStatus;
  readonly message?: string;
  readonly currentChangesetId: number;
  readonly currentBranch?: string;
  readonly model?: IGraphModel;
}

/** One file of an expanded changeset, pre-digested so the client never has to know cm's flags. */
export interface IFileRow {
  readonly path: string;
  /**
   * Identifies the row: one changeset can carry two records for one path (a
   * delete and a re-add), and both would otherwise look the same to a lookup.
   */
  readonly revisionId: number;
  readonly name: string;
  /** Directory without the leading slash; empty at the repository root. */
  readonly directory: string;
  readonly oldPath?: string;
  /** Status letters in the order A, C, M, D; e.g. `CM` for moved and edited. */
  readonly status: string;
  readonly statusTooltip: string;
  readonly revisionType: RevisionType;
  readonly canDiff: boolean;
  /** Why the row cannot be diffed; only set when `canDiff` is false. */
  readonly reason?: string;
}

export interface IReadyMessage {
  readonly type: "ready";
}

export interface IRefreshMessage {
  readonly type: "refresh";
}

export interface ILoadMoreMessage {
  readonly type: "loadMore";
  readonly wkId: string;
  readonly branch: string;
}

export interface IFilesRequestMessage {
  readonly type: "files";
  readonly wkId: string;
  readonly changesetId: number;
}

export interface IOpenDiffMessage {
  readonly type: "openDiff";
  readonly wkId: string;
  readonly changesetId: number;
  readonly path: string;
  /** Absent from an older webview state restored after an update. */
  readonly revisionId?: number;
}

export interface IShowOutputMessage {
  readonly type: "showOutput";
}

/** Webview → extension. */
export type HistoryWebviewMessage =
  | IReadyMessage
  | IRefreshMessage
  | ILoadMoreMessage
  | IFilesRequestMessage
  | IOpenDiffMessage
  | IShowOutputMessage;

export interface IStateMessage {
  readonly type: "state";
  readonly workspaces: IWorkspaceState[];
}

export interface IFilesMessage {
  readonly type: "files";
  readonly wkId: string;
  readonly changesetId: number;
  readonly files: IFileRow[];
}

export interface IFilesErrorMessage {
  readonly type: "filesError";
  readonly wkId: string;
  readonly changesetId: number;
  readonly message: string;
}

/** Extension → webview. */
export type HistoryExtensionMessage = IStateMessage | IFilesMessage | IFilesErrorMessage;

/**
 * Several `onDidChange` events land within one tick while a lane loads; one
 * state post per frame is plenty, since the client re-renders everything anyway.
 */
const POST_COALESCE_MILLIS = 50;

export class HistoryViewProvider implements WebviewViewProvider, Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mExtensionUri: Uri;
  private readonly mGetConfig: () => IConfig;
  private readonly mHistories = new Map<string, WorkspaceHistory>();
  private readonly mDisposables: Disposable[] = [];
  /** Workspaces with an automatic load in flight, so a burst of triggers issues one. */
  private readonly mAutoLoading = new Set<string>();
  /** Workspaces `refresh()` is driving, so its own status event does not reload them twice. */
  private readonly mRefreshing = new Set<string>();
  private mViewDisposables: Disposable[] = [];
  private mView?: WebviewView;
  private mPostTimer?: ReturnType<typeof setTimeout>;
  private mDisposed = false;

  public constructor(plasticScm: PlasticScm, extensionUri: Uri, getConfig: () => IConfig) {
    this.mPlasticScm = plasticScm;
    this.mExtensionUri = extensionUri;
    this.mGetConfig = getConfig;

    for (const workspace of plasticScm.workspaces.values()) {
      const history = new WorkspaceHistory(workspace, plasticScm.channel, this.mGetConfig);
      this.mHistories.set(workspace.info.id, history);
      this.mDisposables.push(
        history,
        history.onDidChange(() => this.schedulePost()),
        // The history's own status subscription was registered first (in its
        // constructor), so by the time this runs `isStale` already reflects the
        // new workspace position.
        workspace.onDidRunStatus(() => this.onWorkspaceStatus(history)));
    }
  }

  public dispose(): void {
    if (this.mDisposed) {
      return;
    }
    this.mDisposed = true;

    if (this.mPostTimer) {
      clearTimeout(this.mPostTimer);
      this.mPostTimer = undefined;
    }
    this.disposeView();
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
    this.mHistories.clear();
  }

  public resolveWebviewView(
      view: WebviewView,
      context: WebviewViewResolveContext,
      token: CancellationToken): void {
    void context;
    void token;

    // Hiding the view from the container menu disposes it, and the next show
    // resolves again: whatever the old view left behind must not receive posts.
    this.disposeView();
    this.mView = view;
    this.mPlasticScm.channel.appendLine(`Graph view resolved (visible: ${view.visible})`);

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.mExtensionUri, "media"),
        Uri.joinPath(this.mExtensionUri, "node_modules", "@vscode", "codicons", "dist"),
      ],
    };
    view.webview.html = this.getHtml(view.webview);

    this.mViewDisposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        this.onMessage(message).catch((e: unknown) => {
          this.mPlasticScm.channel.appendLine(`Graph view message failed: ${describeError(e)}`);
        });
      }),
      view.onDidChangeVisibility(() => this.onVisibilityChanged()),
      view.onDidDispose(() => {
        if (this.mView === view) {
          this.disposeView();
        }
      }));
  }

  public async refresh(): Promise<void> {
    for (const history of this.mHistories.values()) {
      const workspace = history.workspace;
      // The status below fires `onDidRunStatus`, which this provider listens to;
      // without the guard that listener starts its own load and the `load(true)`
      // here only queues a second, identical one behind it.
      this.mRefreshing.add(workspace.info.id);
      try {
        // `cm switch` from a terminal only touches `.plastic`, which the watcher
        // ignores, so the cached branch can be behind the real one.
        await workspace.operations.run(WorkspaceOperation.Status, () => workspace.updateWorkspaceStatus());
        await history.load(true);
      } catch (e) {
        await showOperationError(this.mPlasticScm, "Refresh graph", e);
      } finally {
        this.mRefreshing.delete(workspace.info.id);
      }
    }
  }

  public getHistory(workspaceId: string): WorkspaceHistory | undefined {
    return this.mHistories.get(workspaceId);
  }

  private disposeView(): void {
    const disposables = this.mViewDisposables;
    this.mViewDisposables = [];
    this.mView = undefined;
    Disposable.from(...disposables).dispose();
  }

  private onWorkspaceStatus(history: WorkspaceHistory): void {
    // `refresh()` reloads the workspace itself once its own status run returns.
    if (!this.mView?.visible || this.mRefreshing.has(history.workspace.info.id)) {
      return;
    }

    if (history.isStale) {
      void this.autoLoad(history);
      return;
    }

    void history.checkForNewer().catch((e: unknown) => {
      this.mPlasticScm.channel.appendLine(`Unable to check for new changesets: ${describeError(e)}`);
    });
  }

  private onVisibilityChanged(): void {
    if (!this.mView?.visible) {
      return;
    }

    for (const history of this.mHistories.values()) {
      if (history.isStale) {
        void this.autoLoad(history);
      }
    }
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isMessage(message)) {
      this.mPlasticScm.channel.appendLine(`Ignoring malformed graph view message: ${JSON.stringify(message)}`);
      return;
    }

    switch (message.type) {
    case "ready":
      this.postState();
      for (const history of this.mHistories.values()) {
        if (history.status === "idle" || history.isStale) {
          void this.autoLoad(history);
        }
      }
      return;
    case "refresh":
      await this.refresh();
      return;
    case "loadMore":
      await this.loadMore(message);
      return;
    case "files":
      await this.sendFiles(message);
      return;
    case "openDiff":
      await this.openDiff(message);
      return;
    case "showOutput":
      await commands.executeCommand("plastic-scm.showOutput");
      return;
    default:
      return;
    }
  }

  private async autoLoad(history: WorkspaceHistory): Promise<void> {
    const id = history.workspace.info.id;
    if (this.mAutoLoading.has(id)) {
      return;
    }

    this.mAutoLoading.add(id);
    try {
      await history.load();
    } catch (e) {
      this.mPlasticScm.channel.appendLine(`Unable to load the graph: ${describeError(e)}`);
    } finally {
      this.mAutoLoading.delete(id);
    }
  }

  private async loadMore(message: ILoadMoreMessage): Promise<void> {
    const history = this.mHistories.get(message.wkId);
    if (!history) {
      return;
    }

    try {
      await history.loadMore(message.branch);
    } catch (e) {
      await showOperationError(this.mPlasticScm, "Load more changesets", e);
    }
  }

  private async sendFiles(message: IFilesRequestMessage): Promise<void> {
    const history = this.mHistories.get(message.wkId);
    if (!history) {
      return;
    }

    let reply: IFilesMessage | IFilesErrorMessage;
    try {
      const files = await history.getFiles(message.changesetId);
      reply = {
        changesetId: message.changesetId,
        files: files.map(toFileRow),
        type: "files",
        wkId: message.wkId,
      };
    } catch (e) {
      reply = {
        changesetId: message.changesetId,
        message: describeError(e),
        type: "filesError",
        wkId: message.wkId,
      };
    }
    this.post(reply);
  }

  private async openDiff(message: IOpenDiffMessage): Promise<void> {
    const history = this.mHistories.get(message.wkId);
    if (!history) {
      return;
    }

    try {
      const files = await history.getFiles(message.changesetId);
      const change = findFileChange(files, message.path, message.revisionId);
      const changeset = await history.getChangeset(message.changesetId);
      if (!change || !changeset) {
        void window.showInformationMessage(`Changeset ${message.changesetId} is no longer loaded.`);
        return;
      }
      await openChangesetFileDiff(history.workspace, changeset, change);
    } catch (e) {
      await showOperationError(this.mPlasticScm, "Open diff", e);
    }
  }

  private schedulePost(): void {
    if (this.mPostTimer || this.mDisposed) {
      return;
    }

    this.mPostTimer = setTimeout(() => {
      this.mPostTimer = undefined;
      this.postState();
    }, POST_COALESCE_MILLIS);
  }

  private postState(): void {
    const workspaces: IWorkspaceState[] = [];
    for (const history of this.mHistories.values()) {
      const workspace = history.workspace;
      workspaces.push({
        currentBranch: history.currentBranch,
        currentChangesetId: workspace.currentChangeset,
        id: workspace.info.id,
        message: history.message,
        model: history.model,
        name: workspace.info.name,
        path: workspace.info.path,
        status: history.status,
      });
    }
    this.post({ type: "state", workspaces });
  }

  private post(message: HistoryExtensionMessage): void {
    if (!this.mView) {
      return;
    }

    // A view disposed between the check and the post rejects; nothing to do then.
    this.mView.webview.postMessage(message).then(undefined, () => undefined);
  }

  private getHtml(webview: Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const mediaUri = Uri.joinPath(this.mExtensionUri, "media", "history");
    const styleUri = webview.asWebviewUri(Uri.joinPath(mediaUri, "history.css")).toString();
    const scriptUri = webview.asWebviewUri(Uri.joinPath(mediaUri, "history.js")).toString();
    const codiconUri = webview.asWebviewUri(
      Uri.joinPath(this.mExtensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css")).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return [
      "<!DOCTYPE html>",
      "<html lang=\"en\">",
      "<head>",
      "<meta charset=\"UTF-8\">",
      `<meta http-equiv="Content-Security-Policy" content="${csp};">`,
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
      `<link href="${codiconUri}" rel="stylesheet">`,
      `<link href="${styleUri}" rel="stylesheet">`,
      "<title>Plastic SCM Graph</title>",
      "</head>",
      "<body>",
      "<div id=\"root\"></div>",
      `<script nonce="${nonce}" src="${scriptUri}"></script>`,
      "</body>",
      "</html>",
    ].join("\n");
  }
}

function isMessage(value: unknown): value is HistoryWebviewMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;
  switch (message.type) {
  case "ready":
  case "refresh":
  case "showOutput":
    return true;
  case "loadMore":
    return typeof message.wkId === "string" && typeof message.branch === "string";
  case "files":
    return typeof message.wkId === "string" && typeof message.changesetId === "number";
  case "openDiff":
    return typeof message.wkId === "string"
      && typeof message.changesetId === "number"
      && typeof message.path === "string"
      && (message.revisionId === undefined || typeof message.revisionId === "number");
  default:
    return false;
  }
}

/**
 * One changeset can hold two records for the same path (a delete and a re-add),
 * so a path alone does not identify a row; the revision id does. A webview state
 * restored from before this field existed sends no id, and then the first record
 * for the path is the only available answer.
 */
export function findFileChange(
    files: readonly IChangesetFileChange[],
    path: string,
    revisionId?: number): IChangesetFileChange | undefined {
  const exact = revisionId === undefined
    ? undefined
    : files.find(file => file.path === path && file.revisionId === revisionId);

  return exact ?? files.find(file => file.path === path);
}

export function toFileRow(change: IChangesetFileChange): IFileRow {
  const canDiff = change.revisionType === RevisionType.TextFile && change.status !== FileChangeStatus.None;
  const directory = posix.dirname(change.path).replace(/^\/+/, "");

  return {
    canDiff,
    directory: directory === "." ? "" : directory,
    name: posix.basename(change.path),
    oldPath: change.oldPath,
    path: change.path,
    reason: canDiff ? undefined : describeNoDiff(change),
    revisionId: change.revisionId,
    revisionType: change.revisionType,
    status: describeStatusLetters(change.status),
    statusTooltip: describeStatus(change),
  };
}

const STATUS_LETTERS: ReadonlyArray<[FileChangeStatus, string]> = [
  [ FileChangeStatus.Added, "A" ],
  [ FileChangeStatus.Changed, "C" ],
  [ FileChangeStatus.Moved, "M" ],
  [ FileChangeStatus.Deleted, "D" ],
];

function describeStatusLetters(status: FileChangeStatus): string {
  return STATUS_LETTERS
    .filter(([flag]) => status & flag)
    .map(pair => pair[1])
    .join("");
}

function describeStatus(change: IChangesetFileChange): string {
  const parts: string[] = [];
  if (change.status & FileChangeStatus.Added) {
    parts.push("added");
  }
  if (change.status & FileChangeStatus.Changed) {
    parts.push("changed");
  }
  if (change.status & FileChangeStatus.Deleted) {
    parts.push("deleted");
  }
  if (change.status & FileChangeStatus.Moved) {
    parts.push(`moved from ${change.oldPath ?? "an unknown path"}`);
  }
  if (parts.length === 0) {
    parts.push("no change recorded");
  }

  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.substring(1);
}

function describeNoDiff(change: IChangesetFileChange): string {
  switch (change.revisionType) {
  case RevisionType.Directory:
    return "Directory";
  case RevisionType.BinaryFile:
    return "Binary file: no text diff";
  case RevisionType.TextFile:
    return "No content change";
  default:
    return "Link";
  }
}
