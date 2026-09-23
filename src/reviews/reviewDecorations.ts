import {
  Disposable,
  Event,
  EventEmitter,
  FileDecoration,
  FileDecorationProvider,
  ThemeColor,
  Uri,
  window,
} from "vscode";
import { FileChangeStatus, IChangesetFileChange } from "../models";
import { IReviewComparison } from "./models";
import { reviewFileUri } from "./reviewEditors";
import { toFileRow } from "../history/historyViewProvider";
import { toneColor } from "./reviewPresentation";

/** A decorated URI and the row it stands for. */
export interface IReviewDecorationRow {
  uri: Uri;
  file: IChangesetFileChange;
}

interface IEntry {
  decoration: FileDecoration;
  owner: string;
  uri: Uri;
}

/**
 * The status letters of a row (the Graph's, at most two: `CM` for moved and
 * edited) in Git's colours, so a review reads like the Source Control view.
 * Undefined for a row with no status.
 */
export function reviewFileDecoration(file: IChangesetFileChange): FileDecoration | undefined {
  const row = toFileRow(file);
  const badge = row.status.substring(0, 2);
  if (!badge) {
    return undefined;
  }
  const decoration = new FileDecoration(badge, row.statusTooltip, new ThemeColor(decorationColor(file.status)));
  // A folder row must not turn orange because one file under it changed.
  decoration.propagate = false;
  return decoration;
}

/**
 * Decorations for `plastic-review:` URIs: the review tree's file rows and the
 * diff tabs. Keyed by the exact URI string, so a row, its decoration and its
 * diff's right side must share one URI (`reviewFileUri`). Each comparison
 * registers its rows under an owner and clears them when it is replaced.
 * Rows that are not files (errors, links, loading rows, discarded threads)
 * carry a `toneUri`, answered with its label colour alone.
 */
export class ReviewDecorations implements Disposable, FileDecorationProvider {
  public readonly onDidChangeFileDecorations: Event<Uri[]>;
  private readonly changes = new EventEmitter<Uri[]>();
  private readonly entries = new Map<string, IEntry>();
  private readonly owners = new Map<string, Set<string>>();
  private readonly registration: Disposable;

  public constructor() {
    this.onDidChangeFileDecorations = this.changes.event;
    this.registration = window.registerFileDecorationProvider(this);
  }

  public provideFileDecoration(uri: Uri): FileDecoration | undefined {
    const tone = toneColor(uri);
    if (tone) {
      return new FileDecoration(undefined, undefined, new ThemeColor(tone));
    }
    return this.entries.get(uri.toString())?.decoration;
  }

  /** Replaces what `owner` decorates with `rows`. */
  public set(owner: string, rows: Iterable<IReviewDecorationRow>): void {
    const changed = this.remove(owner);
    const keys = new Set<string>();
    for (const row of rows) {
      const decoration = reviewFileDecoration(row.file);
      if (!decoration) {
        continue;
      }
      const key = row.uri.toString();
      const previous = this.entries.get(key);
      if (previous && previous.owner !== owner) {
        this.owners.get(previous.owner)?.delete(key);
      }
      this.entries.set(key, { decoration, owner, uri: row.uri });
      keys.add(key);
      changed.push(row.uri);
    }
    if (keys.size) {
      this.owners.set(owner, keys);
    }
    this.fire(changed);
  }

  /** Decorates the right-side URI of every row of a comparison. */
  public setComparison(serviceId: string, reviewId: number, comparison: IReviewComparison): void {
    this.set(comparisonOwner(serviceId, comparison), comparison.files.map(file => ({
      file,
      uri: reviewFileUri(serviceId, reviewId, comparison, file),
    })));
  }

  public clearComparison(serviceId: string, comparison: IReviewComparison): void {
    this.clear(comparisonOwner(serviceId, comparison));
  }

  /** Drops what `owner` decorates, or everything when no owner is given. */
  public clear(owner?: string): void {
    if (owner !== undefined) {
      this.fire(this.remove(owner));
      return;
    }
    const all = Array.from(this.entries.values()).map(entry => entry.uri);
    this.entries.clear();
    this.owners.clear();
    this.fire(all);
  }

  public dispose(): void {
    this.registration.dispose();
    this.changes.dispose();
    this.entries.clear();
    this.owners.clear();
  }

  private remove(owner: string): Uri[] {
    const removed: Uri[] = [];
    this.owners.get(owner)?.forEach(key => {
      const entry = this.entries.get(key);
      if (entry?.owner === owner) {
        this.entries.delete(key);
        removed.push(entry.uri);
      }
    });
    this.owners.delete(owner);
    return removed;
  }

  private fire(uris: Uri[]): void {
    if (uris.length) {
      this.changes.fire(uris);
    }
  }
}

/** Comparison ids are unique per workspace only. */
function comparisonOwner(serviceId: string, comparison: IReviewComparison): string {
  return JSON.stringify([ serviceId, comparison.id ]);
}

function decorationColor(status: FileChangeStatus): string {
  if (status & FileChangeStatus.Added) {
    return "gitDecoration.addedResourceForeground";
  }
  if (status & FileChangeStatus.Deleted) {
    return "gitDecoration.deletedResourceForeground";
  }
  if (status & FileChangeStatus.Changed) {
    return "gitDecoration.modifiedResourceForeground";
  }
  return "gitDecoration.renamedResourceForeground";
}
