import { FileChangeStatus, IChangesetFileChange, RevisionType } from "../models";
import { repositoryName } from "./models";

/** The part of `vscode.Memento` the store needs, so tests can pass a plain object. */
export interface IViewedMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface IViewedEntry {
  /** Last time a file of the review was marked or unmarked, epoch ms. */
  t: number;
  revs: string[];
}

interface IViewedState {
  [reviewKey: string]: IViewedEntry | undefined;
}

export const VIEWED_STATE_KEY = "plastic-scm.reviews.viewed.v1";
/** Reviews whose viewed files are kept; the least recently touched go first. */
export const MAX_VIEWED_REVIEWS = 100;

const EMPTY = new Set<string>();

/**
 * The repository part of a key: the name before the first `@`, lower case.
 * cm prints one repository with different server aliases (`…@unity` from
 * diff, a numeric `…@cloud` elsewhere), and `sameRepository` ignores case.
 */
export function repoName(spec: string): string {
  return repositoryName(spec).trim().toLowerCase();
}

export function reviewKey(repository: string, reviewId: number): string {
  return `${repoName(repository)}#${reviewId}`;
}

/**
 * A file is viewed per revision, not per path: the key survives a rename, is
 * shared by the Changes list and a changeset that holds the same revision, and
 * a new checkin (a new revision) makes the file unviewed again. A deletion has
 * no right-side revision, so it is keyed by the deleted revision on the left.
 */
export function revisionKey(file: IChangesetFileChange): string {
  const deleted = !!(file.status & FileChangeStatus.Deleted);
  return `${repoName(file.repository)}#${deleted ? "del:" : ""}${file.revisionId}`;
}

/**
 * Viewed files per review, in `globalState` so they follow the user across
 * workspaces and windows. The memento is read on every lookup (VS Code keeps
 * it in memory and updates it when another window writes), and the set built
 * from an entry is reused for as long as the memento returns that same entry.
 */
export class ViewedStore {
  private readonly sets = new Map<string, { entry: IViewedEntry; revs: Set<string> }>();

  public constructor(private readonly memento: IViewedMemento, private readonly now: () => number = Date.now) {}

  public isViewed(review: string, file: IChangesetFileChange): boolean {
    return file.revisionType !== RevisionType.Directory && this.revisions(review).has(revisionKey(file));
  }

  public count(review: string, files: readonly IChangesetFileChange[]): number {
    const revs = this.revisions(review);
    return files.filter(file => file.revisionType !== RevisionType.Directory && revs.has(revisionKey(file))).length;
  }

  public set(review: string, files: readonly IChangesetFileChange[], viewed: boolean): Promise<void> {
    const revs = new Set(this.revisions(review));
    for (const file of files) {
      if (file.revisionType === RevisionType.Directory) {
        continue;
      }
      if (viewed) {
        revs.add(revisionKey(file));
      } else {
        revs.delete(revisionKey(file));
      }
    }
    // The memento may hand out its own cached object; it is copied, never changed in place.
    const state: IViewedState = { ...this.state() };
    if (revs.size) {
      state[review] = { revs: Array.from(revs), t: this.now() };
    } else {
      delete state[review];
    }
    const kept = prune(state);
    this.sets.forEach((_value, key) => {
      if (!kept[key]) {
        this.sets.delete(key);
      }
    });
    return Promise.resolve(this.memento.update(VIEWED_STATE_KEY, kept));
  }

  private state(): IViewedState {
    const value = this.memento.get<IViewedState>(VIEWED_STATE_KEY);
    return value && typeof value === "object" ? value : {};
  }

  private revisions(review: string): Set<string> {
    const entry = this.state()[review];
    if (!entry || !Array.isArray(entry.revs)) {
      return EMPTY;
    }
    const cached = this.sets.get(review);
    if (cached && cached.entry === entry) {
      return cached.revs;
    }
    const revs = new Set(entry.revs.filter(rev => typeof rev === "string"));
    this.sets.set(review, { entry, revs });
    return revs;
  }
}

function prune(state: IViewedState): IViewedState {
  const keys = Object.keys(state).filter(key => state[key]);
  if (keys.length <= MAX_VIEWED_REVIEWS) {
    return state;
  }
  const time = (key: string) => {
    const t = state[key]?.t;
    return typeof t === "number" ? t : 0;
  };
  const kept: IViewedState = {};
  keys
    .sort((a, b) => time(b) - time(a))
    .slice(0, MAX_VIEWED_REVIEWS)
    .forEach(key => {
      kept[key] = state[key];
    });
  return kept;
}
