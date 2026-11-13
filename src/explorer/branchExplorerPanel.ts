import { BranchExplorerData, ExplorerStatus } from "./explorerData";
import { buildExplorerModel, ExplorerScope, IExplorerModel, IExplorerRow, toFlatExplorerRow } from "./explorerGraph";
import { commands, Disposable, Uri, ViewColumn, Webview, WebviewPanel, window } from "vscode";
import { describeError, showOperationError } from "../commands/scmUtils";
import { findFileChange, IFileRow, toFileRow } from "../history/historyViewProvider";
import { IConfig } from "../config";
import { openChangesetFileDiff } from "../history/openChangesetFileDiff";
import { PlasticScm } from "../plasticScm";
import { randomBytes } from "crypto";
import { Workspace } from "../workspace";

/** The webview panel's type; `webviewId` in menu `when` clauses. */
export const branchExplorerViewType = "plastic-scm.branchExplorer";

/** Everything the client needs to draw the explorer; sent whole on every change. */
export interface IExplorerStateMessage {
  readonly type: "state";
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly status: ExplorerStatus;
  readonly message?: string;
  readonly currentChangesetId: number;
  readonly currentBranch?: string;
  readonly scope: ExplorerScope;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly model: IExplorerModel;
}

export interface IExplorerFilesMessage {
  readonly type: "files";
  readonly changesetId: number;
  readonly files: IFileRow[];
}

export interface IExplorerFilesErrorMessage {
  readonly type: "filesError";
  readonly changesetId: number;
  readonly message: string;
}

export interface IExplorerSearchResultsMessage {
  readonly type: "searchResults";
  readonly text: string;
  readonly rows: IExplorerRow[];
}

export interface IExplorerSearchErrorMessage {
  readonly type: "searchError";
  readonly text: string;
  readonly message: string;
}

/** Extension → webview. */
export type ExplorerExtensionMessage =
  | IExplorerStateMessage
  | IExplorerFilesMessage
  | IExplorerFilesErrorMessage
  | IExplorerSearchResultsMessage
  | IExplorerSearchErrorMessage;

/** Webview → extension. */
export type ExplorerWebviewMessage =
  | { readonly type: "ready" | "refresh" | "loadMore" | "showOutput" }
  | { readonly type: "scope"; readonly scope: ExplorerScope }
  | { readonly type: "files"; readonly changesetId: number }
  | { readonly type: "openDiff"; readonly changesetId: number; readonly path: string; readonly revisionId: number }
  | { readonly type: "search"; readonly text: string };

/** Several change events land within one tick while a page loads; one post per frame is plenty. */
const POST_COALESCE_MILLIS = 50;

interface ISession {
  readonly workspace: Workspace;
  readonly data: BranchExplorerData;
  readonly panel: WebviewPanel;
  readonly disposables: Disposable[];
  scope: ExplorerScope;
  postTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The Branch Explorer: one editor panel per workspace with the graph of every
 * branch, a search box, filters and the details of the selected changeset.
 */
export class BranchExplorer implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mExtensionUri: Uri;
  private readonly mGetConfig: () => IConfig;
  private readonly mSessions = new Map<string, ISession>();

  public constructor(plasticScm: PlasticScm, extensionUri: Uri, getConfig: () => IConfig) {
    this.mPlasticScm = plasticScm;
    this.mExtensionUri = extensionUri;
    this.mGetConfig = getConfig;
  }

  public dispose(): void {
    for (const session of Array.from(this.mSessions.values())) {
      session.panel.dispose();
    }
    this.mSessions.clear();
  }

  /** Opens the explorer of a workspace, or brings its panel forward when it is already open. */
  public open(workspace: Workspace): void {
    const existing = this.mSessions.get(workspace.info.id);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = window.createWebviewPanel(
      branchExplorerViewType,
      this.mPlasticScm.workspaces.size > 1 ? `Branch Explorer: ${workspace.info.name}` : "Branch Explorer",
      ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [
          Uri.joinPath(this.mExtensionUri, "media"),
          Uri.joinPath(this.mExtensionUri, "node_modules", "@vscode", "codicons", "dist"),
        ],
        retainContextWhenHidden: true,
      });

    const data = new BranchExplorerData(workspace, this.mPlasticScm.channel, this.mGetConfig);
    const session: ISession = { data, disposables: [], panel, scope: { kind: "all" }, workspace };
    this.mSessions.set(workspace.info.id, session);

    session.disposables.push(
      data,
      data.onDidChange(() => this.schedulePost(session)),
      // A checkin, a switch or an update moves the workspace's position and may
      // have created changesets; both show in the graph.
      workspace.onDidRunStatus(() => {
        this.schedulePost(session);
        if (panel.visible) {
          void data.loadNewer();
        }
      }),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        this.onMessage(session, message).catch((e: unknown) => {
          this.mPlasticScm.channel.appendLine(`Branch Explorer message failed: ${describeError(e)}`);
        });
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible) {
          void data.loadNewer();
        }
      }),
      panel.onDidDispose(() => this.close(session)));

    panel.webview.html = this.getHtml(panel.webview);
  }

  /** Reloads the explorer of a workspace from the top; all open ones when no id is given. */
  public async refresh(workspaceId?: string): Promise<void> {
    for (const session of this.mSessions.values()) {
      if (workspaceId === undefined || session.workspace.info.id === workspaceId) {
        await session.data.load();
      }
    }
  }

  /** The workspace whose explorer panel is the active editor, for commands in the editor title. */
  public activeWorkspaceId(): string | undefined {
    for (const session of this.mSessions.values()) {
      if (session.panel.active) {
        return session.workspace.info.id;
      }
    }
    return undefined;
  }

  private close(session: ISession): void {
    if (this.mSessions.get(session.workspace.info.id) === session) {
      this.mSessions.delete(session.workspace.info.id);
    }
    if (session.postTimer) {
      clearTimeout(session.postTimer);
      session.postTimer = undefined;
    }
    Disposable.from(...session.disposables).dispose();
    session.disposables.length = 0;
  }

  private async onMessage(session: ISession, message: unknown): Promise<void> {
    if (!isExplorerMessage(message)) {
      this.mPlasticScm.channel.appendLine(`Ignoring malformed Branch Explorer message: ${JSON.stringify(message)}`);
      return;
    }

    switch (message.type) {
    case "ready":
      this.postState(session);
      if (session.data.status === "idle") {
        await session.data.load();
      }
      return;
    case "refresh":
      await session.data.load();
      return;
    case "loadMore":
      try {
        await session.data.loadMore();
      } catch (e) {
        await showOperationError(this.mPlasticScm, "Load more changesets", e);
      }
      return;
    case "scope":
      session.scope = message.scope;
      this.postState(session);
      return;
    case "files":
      await this.sendFiles(session, message.changesetId);
      return;
    case "openDiff":
      await this.openDiff(session, message.changesetId, message.path, message.revisionId);
      return;
    case "search":
      await this.search(session, message.text);
      return;
    case "showOutput":
      await commands.executeCommand("plastic-scm.showOutput");
      return;
    default:
      return;
    }
  }

  private async sendFiles(session: ISession, changesetId: number): Promise<void> {
    try {
      const files = await session.data.getFiles(changesetId);
      this.post(session, { changesetId, files: files.map(toFileRow), type: "files" });
    } catch (e) {
      this.post(session, { changesetId, message: describeError(e), type: "filesError" });
    }
  }

  private async openDiff(session: ISession, changesetId: number, path: string, revisionId: number): Promise<void> {
    try {
      const files = await session.data.getFiles(changesetId);
      const change = findFileChange(files, path, revisionId);
      const changeset = await session.data.getChangeset(changesetId);
      if (!change || !changeset) {
        void window.showInformationMessage(`cs:${changesetId} could not be read again.`);
        return;
      }
      await openChangesetFileDiff(session.workspace, changeset, change);
    } catch (e) {
      await showOperationError(this.mPlasticScm, "Open diff", e);
    }
  }

  private async search(session: ISession, text: string): Promise<void> {
    try {
      const found = await session.data.search(text);
      const current = session.workspace.currentChangeset;
      this.post(session, {
        rows: found.map(changeset => toFlatExplorerRow(changeset, current)),
        text,
        type: "searchResults",
      });
    } catch (e) {
      this.post(session, { message: describeError(e), text, type: "searchError" });
    }
  }

  private schedulePost(session: ISession): void {
    if (session.postTimer) {
      return;
    }
    session.postTimer = setTimeout(() => {
      session.postTimer = undefined;
      this.postState(session);
    }, POST_COALESCE_MILLIS);
  }

  private postState(session: ISession): void {
    if (this.mSessions.get(session.workspace.info.id) !== session) {
      return;
    }

    const { data, workspace } = session;
    const currentBranch = data.currentBranch;
    this.post(session, {
      currentBranch,
      currentChangesetId: workspace.currentChangeset,
      hasMore: data.hasMore,
      loadingMore: data.isLoadingMore,
      message: data.message,
      model: buildExplorerModel({
        changesets: data.changesets,
        currentBranch,
        currentChangesetId: workspace.currentChangeset,
        labels: data.labels,
        merges: data.merges,
        scope: session.scope,
      }),
      scope: session.scope,
      status: data.status,
      type: "state",
      workspaceId: workspace.info.id,
      workspaceName: workspace.info.name,
    });
  }

  private post(session: ISession, message: ExplorerExtensionMessage): void {
    // A panel closed between the check and the post rejects; nothing to do then.
    session.panel.webview.postMessage(message).then(undefined, () => undefined);
  }

  private getHtml(webview: Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const mediaUri = Uri.joinPath(this.mExtensionUri, "media", "explorer");
    const styleUri = webview.asWebviewUri(Uri.joinPath(mediaUri, "explorer.css")).toString();
    const scriptUri = webview.asWebviewUri(Uri.joinPath(mediaUri, "explorer.js")).toString();
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
      "<title>Branch Explorer</title>",
      "</head>",
      "<body>",
      "<div id=\"root\"></div>",
      `<script nonce="${nonce}" src="${scriptUri}"></script>`,
      "</body>",
      "</html>",
    ].join("\n");
  }
}

/** A scope as the webview sent it; anything malformed is rejected rather than trusted. */
export function parseExplorerScope(value: unknown): ExplorerScope | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const scope = value as Record<string, unknown>;
  if (scope.kind === "all" || scope.kind === "current") {
    return { kind: scope.kind };
  }
  if (scope.kind === "branches" && Array.isArray(scope.branches)
      && scope.branches.every(branch => typeof branch === "string")) {
    const branches: string[] = scope.branches;
    return { branches, kind: "branches" };
  }
  return undefined;
}

export function isExplorerMessage(value: unknown): value is ExplorerWebviewMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;
  switch (message.type) {
  case "ready":
  case "refresh":
  case "loadMore":
  case "showOutput":
    return true;
  case "scope":
    return parseExplorerScope(message.scope) !== undefined;
  case "files":
    return Number.isInteger(message.changesetId);
  case "openDiff":
    return Number.isInteger(message.changesetId)
      && typeof message.path === "string"
      && Number.isInteger(message.revisionId);
  case "search":
    return typeof message.text === "string" && message.text.trim().length > 0;
  default:
    return false;
  }
}
