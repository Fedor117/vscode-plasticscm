/** One label as reported by `cm find label --xml` (cm calls the row `<MARKER>`). */
export interface ILabelInfo {
  /** Object id, unique in the repository. */
  readonly id: number;
  /** Label name as typed, e.g. `v1.2 (Android)`; may contain spaces. */
  readonly name: string;
  /** The labelled changeset. */
  readonly changesetId: number;
  /** Full name of the branch the labelled changeset is on, e.g. `/main`. */
  readonly branch: string;
  readonly owner: string;
  readonly date: Date;
  /** Raw comment: may be empty or span several lines. */
  readonly comment: string;
  /** Repository name, e.g. `Nimbus/Nimbus`. */
  readonly repository: string;
  /** Repository server, e.g. `acme-studio@unity`. */
  readonly server: string;
}

/** One shelve as reported by `cm find shelve --xml`. */
export interface IShelveInfo {
  /** The number in `sh:N`; what the user sees and types. */
  readonly shelveId: number;
  /** Object id, unique in the repository. */
  readonly id: number;
  /** The changeset the shelve was created on top of; -1 when unreadable. */
  readonly parentChangesetId: number;
  readonly owner: string;
  readonly date: Date;
  /** Raw comment: may be empty or span several lines. */
  readonly comment: string;
  readonly guid: string;
  readonly repository: string;
  readonly server: string;
}

/** A request for one page of a newest-first listing. */
export interface IListQuery {
  /** Rows wanted; a positive integer. */
  readonly limit: number;
  /** Rows to skip from the newest one; 0 when absent. */
  readonly offset?: number;
}

/** One page of a newest-first listing. */
export interface IListPage<T> {
  readonly items: T[];
  /** True when at least one more row exists after this page. */
  readonly hasMore: boolean;
}
