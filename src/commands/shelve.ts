import * as fs from "fs";
import {
  ApplyShelve,
  Undo as CmUndoCommand,
  CreateShelve,
  DeleteShelve,
  DiffChangeset,
  ListShelves,
} from "../cm/commands";
import { commands, Disposable, env, window } from "vscode";
import { getSelectedResources, groupResourcesByWorkspace } from "./scmUtils";
import { guarded, resolveWorkspace, shelveFileFromNode, shelveFromNode } from "./targets";
import { IOperationHost, runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import {
  IPendingChangesAction,
  IPendingChangesHandler,
  PENDING_CHANGES_HANDLERS,
  setPendingChangesFollowUp,
} from "./pendingChanges";
import { posix, relative } from "path";
import { openShelveFileDiff } from "../history/openChangesetFileDiff";
import { pickShelve } from "../repository/pickers";
import { PlasticScm } from "../plasticScm";
import { shelveSpec } from "../repository/presentation";
import { Workspace } from "../workspace";

export const SHELVE_COMMANDS = {
  apply: "plastic-scm.shelve.apply",
  copyId: "plastic-scm.shelve.copyId",
  create: "plastic-scm.shelve.create",
  createSelected: "plastic-scm.shelve.createSelected",
  delete: "plastic-scm.shelve.delete",
  openFile: "plastic-scm.shelve.openFile",
};

/** Label of the pending-changes dialog's extra button. */
export const SHELVE_AND_CONTINUE_LABEL = "Shelve changes and continue";

const APPLY_NOW = "Apply Shelve Now";

/** Workspace paths of the controlled (non-private) changes among `states`. Private files are never shelved. */
export function controlledPaths(
    states: ReadonlyArray<{ isPrivate: boolean; resourceUri: { fsPath: string } }>): string[] {
  return states.filter(state => !state.isPrivate).map(state => state.resourceUri.fsPath);
}

/** A workspace path as the server path cm prints for shelve contents (`/Assets/a.txt`), lower-cased for comparing. */
function serverPathKey(workspacePath: string, fsPath: string): string {
  return "/" + relative(workspacePath, fsPath).split("\\").join("/").toLowerCase();
}

/**
 * The pending changes that a shelve also changes, by path: applying the shelve
 * would have to merge those files. Compared case-insensitively on purpose; a
 * false overlap only makes the confirmation stricter.
 */
export function shelveOverlap(
    workspacePath: string,
    pendingFsPaths: readonly string[],
    shelveServerPaths: readonly string[]): string[] {
  const shelved = new Set(shelveServerPaths.map(shelvePath => shelvePath.toLowerCase()));
  return pendingFsPaths.filter(fsPath => shelved.has(serverPathKey(workspacePath, fsPath)));
}

/** The comment of a shelve made automatically before a switch or update. */
export function automaticComment(action: IPendingChangesAction, now: Date = new Date()): string {
  const what = action.kind === "switch" ? `switching to ${action.target}` : `updating ${action.target}`;
  return `Shelved by Plastic SCM for VS Code before ${what} (${now.toISOString()})`;
}

/** Splits `paths` into those not written since `sinceMillis` (safe to undo after a shelve) and those that were. */
export function splitByModification(
    paths: readonly string[], sinceMillis: number): { safe: string[]; newer: string[] } {
  const safe: string[] = [];
  const newer: string[] = [];
  for (const item of paths) {
    let modified = false;
    try {
      modified = fs.statSync(item).mtimeMs > sinceMillis;
    } catch {
      // A missing file (a pending delete) has nothing newer to lose.
    }
    (modified ? newer : safe).push(item);
  }
  return { newer, safe };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export interface IShelved {
  /** `sh:N`'s N; undefined when it could not be told. */
  shelveId?: number;
}

/**
 * Shelves `paths` (controlled changes) through the operation runner. Resolves
 * undefined when the shelve failed or another operation was running (the user
 * has been told).
 */
export async function shelvePaths(
    host: IOperationHost,
    workspace: Workspace,
    paths: string[],
    comment: string): Promise<IShelved | undefined> {

  const outcome = await runWorkspaceOperation(
    host,
    workspace,
    {
      name: "Shelve",
      operation: WorkspaceOperation.Shelve,
      refreshStatus: false,
      title: `Shelving ${plural(paths.length, "change")}`,
    },
    async () => {
      const created = await CreateShelve.run(workspace.shell, host.channel, { comment, paths });
      if (created.shelveId !== undefined) {
        return created.shelveId;
      }
      // The spec was not in cm's output; the shelve exists, so find it by the comment it was given.
      if (comment.trim().length > 0) {
        const newest = await ListShelves.run(workspace.shell, { limit: 20 });
        return newest.items.find(shelve => shelve.comment.trim() === comment.trim())?.shelveId;
      }
      return undefined;
    });

  return outcome.status === "succeeded" ? { shelveId: outcome.result } : undefined;
}

/**
 * Undoes the controlled changes at `paths` (`cm undo`, never `-r`, so nothing
 * below a folder is touched that was not listed) and refreshes the status.
 * True when cm succeeded.
 */
export async function undoPaths(host: IOperationHost, workspace: Workspace, paths: string[]): Promise<boolean> {
  const outcome = await runWorkspaceOperation(
    host,
    workspace,
    {
      name: "Undo Changes",
      operation: WorkspaceOperation.UndoCheckout,
      title: `Undoing ${plural(paths.length, "change")}`,
    },
    () => CmUndoCommand.run(workspace.shell, false, ...paths));
  return outcome.status === "succeeded";
}

/**
 * Applies a shelve to the workspace. When the workspace has pending changes
 * the user confirms first, with the files both sides change named, because
 * those are the ones cm would have to merge: `cm shelveset apply` has no
 * non-interactive way to resolve conflicts, so it may open cm's merge tool
 * outside VS Code. Resolves true when cm applied the shelve.
 */
export async function applyShelveToWorkspace(
    host: IOperationHost,
    workspace: Workspace,
    shelveId: number): Promise<boolean> {

  const spec = `sh:${shelveId}`;
  const pending = controlledPaths(workspace.pendingChanges);

  if (pending.length > 0) {
    const shelved = await DiffChangeset.runShelve(workspace.shell, shelveId);
    const overlap = shelveOverlap(workspace.info.path, pending, shelved.map(change => change.path));
    if (overlap.length > 0) {
      // cm would have to merge these, which waits on a prompt the shell cannot answer and ends with the
      // process killed mid-apply. Refuse instead of risking a half-applied workspace.
      const named = overlap.slice(0, 5).map(fsPath => posix.basename(fsPath.split("\\").join("/")));
      void window.showWarningMessage(
        `${spec} was not applied: ${plural(overlap.length, "file")} changed in both the workspace and the shelve ` +
        `(${named.join(", ")}${overlap.length > named.length ? ", ..." : ""}). Check in or shelve your changes ` +
        "to those files first, then apply it again.");
      return false;
    }

    const apply = "Apply";
    const answer = await window.showWarningMessage(
      `Apply ${spec} over ${plural(pending.length, "pending change")} in '${workspace.info.name}'?`,
      {
        detail: "None of them are files the shelve changes, so nothing should need merging.",
        modal: true,
      },
      apply);
    if (answer !== apply) {
      return false;
    }
  }

  const outcome = await runWorkspaceOperation(
    host,
    workspace,
    { name: "Apply Shelve", operation: WorkspaceOperation.Shelve, title: `Applying ${spec}` },
    async () => {
      try {
        return await ApplyShelve.run(workspace.shell, shelveId);
      } catch (e) {
        if (/timed out/i.test((e as Error).message)) {
          throw new Error(
            `${(e as Error).message}. The apply was interrupted, so the workspace may be partly applied: ` +
            "check the pending changes before applying it again.");
        }
        throw e;
      }
    });

  if (outcome.status !== "succeeded") {
    return false;
  }

  host.channel.appendLine(`Applied ${spec} to '${workspace.info.name}'`);
  const conflicted = outcome.result.some(line => /conflict/i.test(line));
  if (conflicted) {
    void window.showWarningMessage(
      `${spec} was applied, but cm reported conflicts. Check the Plastic SCM output and the pending changes.`);
  } else {
    window.setStatusBarMessage(`Applied ${spec}`, 5000);
  }
  return true;
}

/** Shelve commands: create (all or selected), apply, delete, copy the id, open a file of a shelve. */
export class ShelveCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mOnRepositoryChanged: () => void;
  private readonly mDisposables: Disposable[];
  private readonly mHandler: IPendingChangesHandler;

  /** @param onRepositoryChanged Called after shelves changed, so the Repository view reloads. */
  public constructor(plasticScm: PlasticScm, onRepositoryChanged: () => void) {
    this.mPlasticScm = plasticScm;
    this.mOnRepositoryChanged = onRepositoryChanged;
    this.mHandler = {
      detail: "Shelves every pending change, undoes them in the workspace, then goes on. " +
        "You are told the shelve to apply when you want them back. Private files are left alone.",
      label: SHELVE_AND_CONTINUE_LABEL,
      run: (workspace, action) => this.shelveBeforeSwitching(workspace, action),
    };
    PENDING_CHANGES_HANDLERS.push(this.mHandler);

    this.mDisposables = [
      commands.registerCommand(SHELVE_COMMANDS.create, (...args: unknown[]) => this.create(args)),
      commands.registerCommand(SHELVE_COMMANDS.createSelected, (...args: unknown[]) => this.createSelected(args)),
      commands.registerCommand(SHELVE_COMMANDS.apply, (...args: unknown[]) => this.apply(args)),
      commands.registerCommand(SHELVE_COMMANDS.delete, (...args: unknown[]) => this.delete(args)),
      commands.registerCommand(SHELVE_COMMANDS.copyId, (...args: unknown[]) => this.copyId(args)),
      commands.registerCommand(SHELVE_COMMANDS.openFile, (...args: unknown[]) => this.openFile(args)),
    ];
  }

  public dispose(): void {
    const index = PENDING_CHANGES_HANDLERS.indexOf(this.mHandler);
    if (index >= 0) {
      PENDING_CHANGES_HANDLERS.splice(index, 1);
    }
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async create(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace should be shelved?");
    if (!workspace) {
      return;
    }
    await this.shelveInteractively(workspace, controlledPaths(workspace.pendingChanges));
  }

  private async createSelected(args: unknown[]): Promise<void> {
    const resources = getSelectedResources(args).filter(resource => !resource.isPrivate);
    if (resources.length === 0) {
      void window.showInformationMessage(
        "Select changed files to shelve. Private files cannot be shelved: add them to source control first.");
      return;
    }
    for (const [ workspace, owned ] of groupResourcesByWorkspace(this.mPlasticScm, resources)) {
      await this.shelveInteractively(workspace, controlledPaths(owned));
    }
  }

  /** Asks for a comment, shelves, then offers to undo what was shelved. */
  private async shelveInteractively(workspace: Workspace, paths: string[]): Promise<void> {
    if (paths.length === 0) {
      void window.showInformationMessage(`'${workspace.info.name}' has no pending changes to shelve.`);
      return;
    }

    const comment = await window.showInputBox({
      ignoreFocusOut: true,
      prompt: `Comment for the shelve of ${plural(paths.length, "change")} in '${workspace.info.name}' ` +
        "(optional). Enter to continue without one.",
      title: "Shelve Changes",
    });
    if (comment === undefined) {
      return;
    }

    await guarded(this.mPlasticScm, "Shelve", async () => {
      const shelveStartedAt = Date.now();
      const shelved = await shelvePaths(this.mPlasticScm, workspace, paths, comment);
      if (!shelved) {
        return;
      }
      this.mOnRepositoryChanged();

      const shelvedAt = shelveStartedAt;
      const spec = shelved.shelveId === undefined ? "the shelve" : `sh:${shelved.shelveId}`;
      const undo = "Undo Changes";
      const answer = await window.showWarningMessage(
        `Shelved ${plural(paths.length, "change")} as ${spec}. Undo them in '${workspace.info.name}'?`,
        {
          detail: `The changes are saved in ${spec} and can be applied again. Undoing reverts those controlled ` +
            "files to their checked-in content. Private files are not touched.",
          modal: true,
        },
        undo);
      if (answer === undo) {
        // The modal can stay open for a long time; files written since the shelve are not in it.
        const { safe, newer } = splitByModification(paths, shelvedAt);
        if (newer.length > 0) {
          const names = newer.slice(0, 3).map(item => posix.basename(item.split("\\").join("/")));
          void window.showWarningMessage(
            `${plural(newer.length, "file")} changed after the shelve was made and were left alone, because ` +
            `${spec} does not hold the newest edits: ${names.join(", ")}` +
            `${newer.length > names.length ? ", ..." : ""}.`);
        }
        if (safe.length > 0) {
          await undoPaths(this.mPlasticScm, workspace, safe);
        }
      }
    });
  }

  /** The "Shelve changes and continue" button of the switch/update dialog. */
  private async shelveBeforeSwitching(workspace: Workspace, action: IPendingChangesAction): Promise<boolean> {
    const paths = controlledPaths(workspace.pendingChanges);
    if (paths.length === 0) {
      return true;
    }

    const shelved = await shelvePaths(this.mPlasticScm, workspace, paths, automaticComment(action));
    if (!shelved) {
      return false;
    }
    this.mOnRepositoryChanged();

    if (shelved.shelveId === undefined) {
      // Undoing without knowing where the changes went could lose them.
      void window.showWarningMessage(
        "The changes were shelved, but cm did not say which shelve it is, so nothing was undone and the " +
        "switch did not start. Find the shelve in the Plastic SCM Repository view.");
      return false;
    }

    if (!await undoPaths(this.mPlasticScm, workspace, paths)) {
      void window.showWarningMessage(
        `Your changes are saved in sh:${shelved.shelveId}, but undoing them failed, so the ` +
        `${action.kind} did not start.`);
      return false;
    }

    const id = shelved.shelveId;
    setPendingChangesFollowUp(workspace, async succeeded => {
      const message = succeeded
        ? `Your ${plural(paths.length, "pending change")} are in sh:${id}. Apply it when you want them back.`
        : `The ${action.kind} did not finish. Your ${plural(paths.length, "pending change")} are saved in ` +
          `sh:${id}; apply it to get them back.`;
      const answer = succeeded
        ? await window.showInformationMessage(message, APPLY_NOW)
        : await window.showWarningMessage(message, APPLY_NOW);
      if (answer === APPLY_NOW) {
        await guarded(this.mPlasticScm, "Apply Shelve", async () => {
          if (await applyShelveToWorkspace(this.mPlasticScm, workspace, id)) {
            this.mOnRepositoryChanged();
          }
        });
      }
    });
    return true;
  }

  private async apply(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(
      this.mPlasticScm, args, "Which workspace should the shelve be applied to?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Apply Shelve", async () => {
      const shelve = shelveFromNode(args[0]) ?? await pickShelve(workspace.shell, {
        placeHolder: "Pick the shelve to apply",
        title: "Apply Shelve",
        workspaceConfig: workspace.workspaceConfig,
      });
      if (shelve) {
        await applyShelveToWorkspace(this.mPlasticScm, workspace, shelve.shelveId);
      }
    });
  }

  private async delete(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace has the shelve to delete?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Delete Shelve", async () => {
      const shelve = shelveFromNode(args[0]) ?? await pickShelve(workspace.shell, {
        placeHolder: "Pick the shelve to delete",
        title: "Delete Shelve",
        workspaceConfig: workspace.workspaceConfig,
      });
      if (!shelve) {
        return;
      }

      const spec = shelveSpec(shelve);
      const remove = "Delete";
      const comment = shelve.comment.trim().length > 0 ? ` "${shelve.comment.trim().split("\n")[0]}"` : "";
      const answer = await window.showWarningMessage(
        `Delete shelve ${spec}${comment}?`,
        { detail: "A deleted shelve cannot be brought back, and the changes stored in it are lost.", modal: true },
        remove);
      if (answer !== remove) {
        return;
      }

      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        {
          name: "Delete Shelve",
          operation: WorkspaceOperation.Shelve,
          refreshStatus: false,
          title: `Deleting ${spec}`,
        },
        () => DeleteShelve.run(workspace.shell, shelve.shelveId));
      if (outcome.status === "succeeded") {
        this.mOnRepositoryChanged();
        window.setStatusBarMessage(`Deleted ${spec}`, 5000);
      }
    });
  }

  private async copyId(args: unknown[]): Promise<void> {
    const shelve = shelveFromNode(args[0]);
    if (!shelve) {
      return;
    }
    await env.clipboard.writeText(shelveSpec(shelve));
    window.setStatusBarMessage(`Copied ${shelveSpec(shelve)}`, 3000);
  }

  private async openFile(args: unknown[]): Promise<void> {
    const target = shelveFileFromNode(args[0]);
    const workspaceId = (args[0] as { workspace?: { info?: { id?: string } } } | undefined)?.workspace?.info?.id;
    if (!target || workspaceId === undefined) {
      return;
    }
    await guarded(this.mPlasticScm, "Open Shelved File", () =>
      openShelveFileDiff(workspaceId, target.shelve, target.change));
  }
}
