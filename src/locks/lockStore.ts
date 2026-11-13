import { buildEntries, LockSnapshot } from "./lockSnapshot";
import { Event, EventEmitter } from "vscode";
import { ICmShell } from "../cm/shell";
import { ListLocks } from "../cm/commands";

/** `lock list` is never run for the file badges more often than this, unless the user asks. */
export const LOCK_REFRESH_INTERVAL_MILLIS = 60 * 1000;

export interface ILockStoreHost {
  readonly shell: ICmShell;
  /** The workspace's repository spec; may be unknown before the first status. */
  repSpec(): string | undefined;
  log(message: string): void;
}

/**
 * The locks of one workspace's repository. `lock list` runs on explicit
 * {@link refresh} and, for the file badges, through {@link refreshIfStale},
 * which waits {@link LOCK_REFRESH_INTERVAL_MILLIS} between runs (a failed run
 * counts too, so a server without lock support is not asked every status).
 * After a failed automatic run no more automatic runs happen until an explicit
 * {@link refresh} succeeds: a slow server would otherwise time out, and get the
 * workspace's cm shell restarted, about once a minute.
 */
export class LockStore {
  public readonly onDidChange: Event<void>;

  private readonly mEmitter = new EventEmitter<void>();
  private mSnapshot = LockSnapshot.empty;
  private mLastRun?: number;
  private mRunning?: Promise<LockSnapshot>;
  private mbAutomaticStopped = false;
  private mNext?: Promise<LockSnapshot>;

  public constructor(
      private readonly mHost: ILockStoreHost,
      private readonly mNow: () => number = () => Date.now()) {
    this.onDidChange = this.mEmitter.event;
  }

  public get snapshot(): LockSnapshot {
    return this.mSnapshot;
  }

  /**
   * Runs `lock list` now. Rejects when cm fails; a concurrent call shares the run,
   * unless it asks for `fresh` data (e.g. right after an unlock), in which case it
   * gets a run that starts after the one in flight has finished.
   */
  public refresh(options: { fresh?: boolean } = {}): Promise<LockSnapshot> {
    if (this.mRunning) {
      if (!options.fresh) {
        return this.mRunning;
      }
      this.mNext ??= this.mRunning.catch(() => undefined).then(() => {
        this.mNext = undefined;
        return this.refresh();
      });
      return this.mNext;
    }

    const run = this.load().finally(() => {
      this.mRunning = undefined;
    });
    this.mRunning = run;
    return run;
  }

  /** For badges: runs `lock list` only when the last run is older than the interval. Never rejects. */
  public async refreshIfStale(): Promise<void> {
    if (this.mRunning) {
      await this.mRunning.catch(() => undefined);
      return;
    }
    if (this.mbAutomaticStopped) {
      return;
    }
    if (this.mLastRun !== undefined && this.mNow() - this.mLastRun < LOCK_REFRESH_INTERVAL_MILLIS) {
      return;
    }

    try {
      await this.refresh();
    } catch (e) {
      this.mbAutomaticStopped = true;
      this.mHost.log(
        `Unable to list locks: ${(e as Error).message}. Locks are not refreshed automatically any more ` +
        "this session; use Refresh Locks.");
    }
  }

  public dispose(): void {
    this.mEmitter.dispose();
  }

  private async load(): Promise<LockSnapshot> {
    this.mLastRun = this.mNow();

    const repository = this.mHost.repSpec();
    const known = repository !== undefined && repository !== "unknown@unknown" ? repository : undefined;
    const all = await ListLocks.run(this.mHost.shell, { repository: known });
    const mine = await ListLocks.run(this.mHost.shell, { onlyCurrentUser: true, repository: known });

    this.mbAutomaticStopped = false;
    this.mSnapshot = new LockSnapshot(buildEntries(all, mine, this.mHost.repSpec()));
    this.mEmitter.fire();
    return this.mSnapshot;
  }
}
