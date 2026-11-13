/** One revision of one file, as `cm history` lists it. */
export interface IFileRevision {
  readonly changesetId: number;
  /** Full branch name, e.g. `/main/task001`. */
  readonly branch: string;
  readonly owner: string;
  readonly date: Date;
  /** Raw comment: may be empty or span several lines. */
  readonly comment: string;
  /** cm's revision type as printed, e.g. `txt`, `bin` or `dir`. */
  readonly type: string;
  /** What cm calls the revision, e.g. `./Assets/a.cs#cs:42`. */
  readonly spec: string;
  readonly itemId: number;
  readonly size: number;
  readonly repository: string;
  readonly server: string;
}

/** One line of `cm annotate`: the changeset that last changed it. */
export interface IAnnotatedLine {
  /** 1-based, as cm numbers lines. */
  readonly line: number;
  readonly changesetId: number;
  readonly owner: string;
  readonly date: Date;
  readonly content: string;
}
