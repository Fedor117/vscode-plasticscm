import {
  commands,
  Disposable,
  TextDocumentShowOptions,
  Uri,
  ViewColumn,
  window,
} from "vscode";
import { ChangeType } from "../models";
import { existsSync } from "fs";
import { getSelectedResources } from "./scmUtils";
import { PlasticScm } from "../plasticScm";
import { PlasticScmResource } from "../plasticScmResource";

export class OpenFileCommand implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposable?: Disposable;

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposable = commands.registerCommand(
      "plastic-scm.openFile", (...args: unknown[]) => this.execute(args));
  }

  public dispose(): void {
    if (this.mDisposable) {
      this.mDisposable.dispose();
    }
  }

  public async execute(args: unknown[]): Promise<void> {
    const first = args.length > 0 ? args[0] : undefined;
    const preserveFocus = first instanceof PlasticScmResource;

    let uris: Uri[] | undefined;

    if (first instanceof Uri) {
      if (first.scheme === "file") {
        uris = [first];
      }
    } else {
      const resources = getSelectedResources(args);

      if (resources.length > 0) {
        // Directories are dropped as well as deletions: `vscode.open` on one just
        // reports "the file is not displayed in the text editor because it is a
        // directory". The menu already hides the entry, but a multi-selection can
        // still drag a folder in alongside the file the user actually clicked.
        uris = resources
          .filter(resource => resource.type !== ChangeType.Deleted && !resource.isDirectory)
          .map(resource => resource.resourceUri);
      } else if (window.activeTextEditor) {
        uris = [window.activeTextEditor.document.uri];
      }
    }

    if (!uris) {
      return;
    }

    const activeTextEditor = window.activeTextEditor;
    // Must extract these now because opening a new document will change the activeTextEditor reference
    const previousVisibleRange = activeTextEditor?.visibleRanges[0];
    const previousURI = activeTextEditor?.document.uri;
    const previousSelection = activeTextEditor?.selection;

    for (const uri of uris) {
      const opts: TextDocumentShowOptions = {
        preserveFocus,
        preview: false,
        viewColumn: ViewColumn.Active,
      };

      if (uri.scheme === "file" && !existsSync(uri.fsPath)) {
        continue;
      }

      await commands.executeCommand("vscode.open", uri, {
        ...opts,
      });

      const document = window.activeTextEditor?.document;

      // If the document doesn't match what we opened then don't attempt to select the range
      // Additioanlly if there was no previous document we don't have information to select a range
      if (document?.uri.toString() !== uri.toString() || !activeTextEditor || !previousURI || !previousSelection) {
        continue;
      }

      // Check if active text editor has same path as other editor. we cannot compare via
      // URI.toString() here because the schemas can be different. Instead we just go by path.
      if (previousURI.path === uri.path && document) {
        // preserve not only selection but also visible range
        opts.selection = previousSelection;
        const editor = await window.showTextDocument(document, opts);
        // This should always be defined but just in case
        if (previousVisibleRange) {
          editor.revealRange(previousVisibleRange);
        }
      }
    }
  }
}
