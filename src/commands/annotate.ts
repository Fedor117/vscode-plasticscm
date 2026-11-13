import * as path from "path";
import {
  AnnotateFailure,
  annotationLabels,
  annotationMatches,
  annotationWidth,
  classifyAnnotateFailure,
} from "../annotate/annotation";
import { ChangeType, IAnnotatedLine, IChangesetFileChange, IHistoryChangeset } from "../models";
import {
  commands,
  Disposable,
  Hover,
  languages,
  MarkdownString,
  Position,
  ProgressLocation,
  Range,
  TextDocument,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  Uri,
  workspace as VsCodeWorkspace,
  window,
} from "vscode";
import { describeError, showOperationError } from "./scmUtils";
import { Annotate } from "../cm/commands/annotate/annotate";
import { COMPARISON_COMMANDS } from "../comparison/comparisonTree";
import { DiffChangeset } from "../cm/commands/diffChangeset/diffChangeset";
import { FindChangesets } from "../cm/commands/findChangesets/findChangesets";
import { formatDate } from "../repository/presentation";
import { groupUrisByWorkspace } from "./fileTargets";
import { openChangesetFileDiff } from "../history/openChangesetFileDiff";
import { PlasticScm } from "../plasticScm";
import { Workspace } from "../workspace";

export const ANNOTATE_COMMANDS = {
  openChanges: "plastic-scm.annotate.openChanges",
  toggle: "plastic-scm.annotate.toggle",
};

/** The messages for what cm refuses to annotate; pure so the wording is tested. */
export function describeAnnotateFailure(kind: AnnotateFailure, fileName: string, cmMessage: string): string {
  switch (kind) {
  case "binary":
    return `${fileName} is a binary file. Plastic SCM annotates text files only.`;
  case "notControlled":
    return `${fileName} is not under Plastic SCM source control, so there is nothing to annotate.`;
  default:
    return `Unable to annotate ${fileName}: ${cmMessage}`;
  }
}

/** The args of `plastic-scm.annotate.openChanges`, carried through the hover's command link. */
export interface IAnnotateLinkArgs {
  readonly wkId: string;
  readonly changesetId: number;
  /** The file's path in the workspace, as a `file:` URI string. */
  readonly file: string;
}

function isLinkArgs(arg: unknown): arg is IAnnotateLinkArgs {
  if (typeof arg !== "object" || arg === null) {
    return false;
  }
  const candidate = arg as Record<string, unknown>;
  return typeof candidate.wkId === "string" && typeof candidate.file === "string"
    && typeof candidate.changesetId === "number" && Number.isInteger(candidate.changesetId);
}

interface IAnnotation {
  readonly workspace: Workspace;
  readonly lines: readonly IAnnotatedLine[];
  readonly labels: readonly string[];
}

/** The hover of an annotated line: what the changeset was, and the ways to open it. */
export function annotationHover(
    wkId: string, file: Uri, line: IAnnotatedLine, changeset: IHistoryChangeset | undefined): MarkdownString {
  const text = new MarkdownString();
  text.isTrusted = { enabledCommands: [ ANNOTATE_COMMANDS.openChanges, COMPARISON_COMMANDS.showChangeset ] };
  text.appendMarkdown(`**cs:${line.changesetId}**`);
  if (changeset) {
    text.appendText(` on ${changeset.branch}`);
  }
  text.appendMarkdown("\n\n");
  text.appendText(`${line.owner}, ${formatDate(line.date)}`);

  const comment = changeset?.comment.trim();
  if (comment) {
    text.appendMarkdown("\n\n");
    text.appendText(comment);
  }

  const link = (command: string, args: unknown, title: string) =>
    `[${title}](command:${command}?${encodeURIComponent(JSON.stringify([args]))})`;
  text.appendMarkdown("\n\n");
  text.appendMarkdown([
    link(ANNOTATE_COMMANDS.openChanges, { changesetId: line.changesetId, file: file.toString(), wkId }, "Open Changes"),
    link(COMPARISON_COMMANDS.showChangeset, { changesetId: line.changesetId, wkId }, "Show Changed Files"),
  ].join(" &nbsp;|&nbsp; "));
  return text;
}

/**
 * Toggle Annotate (Blame): a gutter of owner, changeset and date in front of
 * every line of the active file. It clears when toggled off, when the file is
 * closed and when its text is edited, because after an edit the lines no longer
 * line up with what cm annotated.
 */
export class AnnotateCommands implements Disposable {
  private readonly mAnnotations = new Map<string, IAnnotation>();
  private readonly mChangesets = new Map<string, IHistoryChangeset | undefined>();
  private readonly mDecoration: TextEditorDecorationType;
  private readonly mDisposables: Disposable[];

  public constructor(private readonly mPlasticScm: PlasticScm) {
    this.mDecoration = window.createTextEditorDecorationType({});
    this.mDisposables = [
      this.mDecoration,
      commands.registerCommand(ANNOTATE_COMMANDS.toggle, () => this.toggle()),
      commands.registerCommand(ANNOTATE_COMMANDS.openChanges, (arg: unknown) => this.openChanges(arg)),
      languages.registerHoverProvider({ scheme: "file" }, { provideHover: (document, position) =>
        this.provideHover(document, position) }),
      VsCodeWorkspace.onDidCloseTextDocument(document => this.clear(document.uri)),
      VsCodeWorkspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length > 0) {
          this.clear(event.document.uri);
        }
      }),
      window.onDidChangeVisibleTextEditors(editors => {
        editors.forEach(editor => this.render(editor));
      }),
    ];
  }

  public dispose(): void {
    this.mAnnotations.clear();
    this.mDisposables.forEach(disposable => {
      disposable.dispose();
    });
  }

  private async toggle(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      void window.showInformationMessage("Open a file from a Plastic SCM workspace to annotate it.");
      return;
    }

    const uri = editor.document.uri;
    if (this.mAnnotations.has(uri.toString())) {
      this.clear(uri);
      return;
    }

    const [workspace] = groupUrisByWorkspace(this.mPlasticScm, [uri]).keys();
    if (!workspace) {
      void window.showInformationMessage(`${path.basename(uri.fsPath)} is not inside a Plastic SCM workspace.`);
      return;
    }

    const fileName = path.basename(uri.fsPath);
    if (editor.document.isDirty) {
      void window.showInformationMessage(`Save ${fileName} first: annotate describes the saved file.`);
      return;
    }

    const state = workspace.statusResourceGroup.resourceStates.find(item => item.resourceUri.fsPath === uri.fsPath);
    if (state && (state.type & ChangeType.Private)) {
      void window.showInformationMessage(describeAnnotateFailure("notControlled", fileName, ""));
      return;
    }

    let lines: IAnnotatedLine[];
    try {
      lines = await window.withProgress(
        { location: ProgressLocation.Window, title: `Annotating ${fileName}…` },
        () => Annotate.run(workspace.shell, uri.fsPath));
    } catch (e) {
      const message = describeError(e);
      const kind = classifyAnnotateFailure(message);
      if (kind === "other") {
        await showOperationError(this.mPlasticScm, "Annotate", e);
      } else {
        void window.showInformationMessage(describeAnnotateFailure(kind, fileName, message));
      }
      return;
    }

    // The editor may have been edited or closed while cm worked.
    if (editor.document.isDirty || editor.document.isClosed) {
      return;
    }
    if (!annotationMatches(lines, editor.document.getText())) {
      void window.showInformationMessage(
        `${fileName} differs from the revision in the workspace (pending changes), so its lines cannot be ` +
        "matched to changesets. Undo or check in the changes first.");
      return;
    }

    const labels = annotationLabels(lines);
    this.mAnnotations.set(uri.toString(), { labels, lines, workspace });
    window.visibleTextEditors.forEach(visible => this.render(visible));
  }

  private clear(uri: Uri): void {
    if (this.mAnnotations.delete(uri.toString())) {
      window.visibleTextEditors
        .filter(editor => editor.document.uri.toString() === uri.toString())
        .forEach(editor => editor.setDecorations(this.mDecoration, []));
    }
  }

  private render(editor: TextEditor): void {
    const annotation = this.mAnnotations.get(editor.document.uri.toString());
    if (!annotation) {
      return;
    }

    const width = `${annotationWidth(annotation.labels)}ch`;
    const color = new ThemeColor("editorCodeLens.foreground");
    editor.setDecorations(this.mDecoration, annotation.lines
      .filter(line => line.line >= 1 && line.line <= editor.document.lineCount)
      .map(line => ({
        range: new Range(line.line - 1, 0, line.line - 1, 0),
        renderOptions: {
          before: {
            color,
            contentText: annotation.labels[line.line - 1],
            margin: "0 1.5em 0 0",
            width,
          },
        },
      })));
  }

  private async provideHover(document: TextDocument, position: Position): Promise<Hover | undefined> {
    const annotation = this.mAnnotations.get(document.uri.toString());
    if (!annotation || position.character !== 0) {
      return undefined;
    }

    const line = annotation.lines.find(candidate => candidate.line === position.line + 1);
    if (!line) {
      return undefined;
    }

    const changeset = await this.changeset(annotation.workspace, line.changesetId);
    return new Hover(annotationHover(annotation.workspace.info.id, document.uri, line, changeset));
  }

  /** The changeset behind a line, cached; a failed lookup only loses the comment. */
  private async changeset(workspace: Workspace, id: number): Promise<IHistoryChangeset | undefined> {
    const key = `${workspace.info.id}:${id}`;
    if (this.mChangesets.has(key)) {
      return this.mChangesets.get(key);
    }

    try {
      const changeset = await FindChangesets.runById(workspace.shell, id, { ignoreHidden: false });
      this.mChangesets.set(key, changeset);
      return changeset;
    } catch (e) {
      this.mPlasticScm.channel.appendLine(`Unable to read cs:${id} for annotate: ${describeError(e)}`);
      return undefined;
    }
  }

  /** Opens the diff of the annotated file in the changeset a hover link names. */
  private async openChanges(arg: unknown): Promise<void> {
    if (!isLinkArgs(arg)) {
      return;
    }

    const workspace = this.mPlasticScm.workspaces.get(arg.wkId);
    if (!workspace) {
      return;
    }

    try {
      const changeset = await this.changeset(workspace, arg.changesetId);
      if (!changeset) {
        void window.showInformationMessage(`cs:${arg.changesetId} was not found.`);
        return;
      }

      const serverPath = "/" + path.relative(workspace.info.path, Uri.parse(arg.file).fsPath).split(path.sep).join("/");
      const changes = await DiffChangeset.run(workspace.shell, changeset.id);
      const change: IChangesetFileChange | undefined =
        changes.find(candidate => candidate.path === serverPath)
        ?? changes.find(candidate => candidate.path.toLowerCase() === serverPath.toLowerCase());
      if (!change) {
        void window.showInformationMessage(
          `${path.basename(serverPath)} is not listed in cs:${changeset.id}; it may have been moved since.`);
        return;
      }

      await openChangesetFileDiff(workspace, changeset, change);
    } catch (e) {
      await showOperationError(this.mPlasticScm, "Open Changes", e);
    }
  }
}
