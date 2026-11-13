/** One lock, as `cm lock list --machinereadable --smartlocks` prints it. */
export interface ILockInfo {
  /** `org/repo`, as cm prints it (no server). */
  readonly repository: string;
  readonly itemId: number;
  readonly guid: string;
  /** Formatted by cm as `yyyy-MM-dd HH:mm:ss`, in the machine's time zone. */
  readonly date: string;
  /** The branch the lock will be released on. */
  readonly destinationBranch: string;
  readonly destinationRevisionId: number;
  /** The branch the lock was taken on. */
  readonly holderBranch: string;
  readonly holderRevisionId: number;
  /** `Locked` or `Retained`. */
  readonly status: string;
  readonly owner: string;
  /** Name of the workspace the lock was taken in. */
  readonly workspace: string;
  /** Server path of the item, e.g. `/Assets/Art/hero.psd`. */
  readonly path: string;
}

/** A lock and whether the current user holds it. */
export interface ILockEntry extends ILockInfo {
  readonly mine: boolean;
}
