import { RevisionType } from "./changeInfo";

/** One changeset as reported by `cm find changeset --xml`. */
export interface IHistoryChangeset {
  readonly id: number;
  /** Parent changeset id; -1 for the repository root. */
  readonly parentId: number;
  /** Full branch name, e.g. `/main/task001`. */
  readonly branch: string;
  readonly owner: string;
  readonly date: Date;
  /** Raw comment: may be empty or span several lines. */
  readonly comment: string;
  readonly guid: string;
  /** Repository name, e.g. `Nimbus/Nimbus`. */
  readonly repository: string;
  /** Repository server, e.g. `acme-studio@unity`. */
  readonly server: string;
}

/** One branch as reported by `cm find branch --xml`. */
export interface IBranchInfo {
  /** Full name, e.g. `/main/task001`. */
  readonly name: string;
  /** Full parent name; undefined for a root branch such as `/main`. */
  readonly parent?: string;
  readonly headChangesetId: number;
  readonly owner: string;
  readonly date: Date;
  readonly comment: string;
  readonly guid: string;
  readonly repository: string;
  readonly server: string;
}

/** A merge, cherry pick or interval merge link between two changesets. */
export interface IMergeLink {
  /** cm's type name: `merge`, `cherrypick`, `interval`... */
  readonly type: string;
  /** Full branch name without cm's `br:` prefix. */
  readonly sourceBranch: string;
  readonly sourceChangesetId: number;
  /** Full branch name without cm's `br:` prefix. */
  readonly destinationBranch: string;
  readonly destinationChangesetId: number;
}

/**
 * Flags rather than an enum because cm reports a moved-and-edited file as two
 * rows, one `C` and one `M`, which the parser folds into a single entry.
 */
export enum FileChangeStatus {
  None = 0,
  Added = 1 << 0,
  Changed = 1 << 1,
  Deleted = 1 << 2,
  Moved = 1 << 3,
}

/** One item changed by a changeset, as reported by `cm diff cs:N --format`. */
export interface IChangesetFileChange {
  readonly status: FileChangeStatus;
  readonly revisionType: RevisionType;
  /** Server path with the quotes stripped, e.g. `/Assets/Foo.cs`; the destination path for moves. */
  readonly path: string;
  /** Server path before a move. */
  readonly oldPath?: string;
  /** Destination revision; for a deleted item this is the revision that was deleted. */
  readonly revisionId: number;
  /** Revision in the parent changeset's tree, or -1 when the item did not exist there. */
  readonly baseRevisionId: number;
  /** Previous revision in the item's own history, or -1. */
  readonly parentRevisionId: number;
  /** Repository spec of the item, e.g. `Nimbus/Nimbus@acme-studio@unity`. */
  readonly repository: string;
}
