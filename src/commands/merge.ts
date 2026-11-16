import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchFromNode, explorerChangesetFromArg, guarded, resolveWorkspace } from "./targets";
import { commands, Disposable, QuickPickItem, Uri, window } from "vscode";
import {
  DirectoryResolution,
  IDirectoryConflict,
  IMergeReport,
  IMergeResolutionFiles,
  IMergeResult,
  Merge,
  Undo,
} from "../cm/commands";
import { IWorkspaceConfig, WkConfigType } from "../models";
import { runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { countPendingChanges } from "./pendingChanges";
import { pickBranch } from "../repository/pickers";
import { PlasticScm } from "../plasticScm";
import { Workspace } from "../workspace";

export const MERGE_COMMANDS = {
  abort: "plastic-scm.merge.abort",
  fromBranch: "plastic-scm.merge.fromBranch",
  markResolved: "plastic-scm.merge.markResolved",
  openConflicts: "plastic-scm.merge.openConflicts",
};

const MAX_LISTED = 10;
const ABORT = "Abort Merge";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function listed(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_LISTED);
  if (lines.length > shown.length) {
    shown.push(`… and ${lines.length - shown.length} more`);
  }
  return shown.join("\n");
}

/** What the command needs to know about the workspace before it asks cm anything. */
export interface IMergeWorkspaceState {
  readonly name: string;
  readonly config: IWorkspaceConfig | undefined;
  /** Pending changes that are not private files. */
  readonly pendingChanges: number;
  /** The branch has changesets newer than the one the workspace is on. */
  readonly hasIncomingChanges: boolean;
}

/**
 * Why `source` cannot be merged into the workspace as it is, or undefined when it can.
 *
 * The merge needs a workspace without pending changes: cm refuses otherwise
 * (unless `MergeWithPendingChanges` is set in client.conf), and it is what
 * makes Abort Merge undo the merge and nothing else.
 */
export function mergeObstacle(source: string, state: IMergeWorkspaceState): string | undefined {
  if (state.config?.configType !== WkConfigType.Branch) {
    return `'${state.name}' is not on a branch. Switch it to the branch that should receive the merge first.`;
  }
  if (state.config.location === source) {
    return `'${state.name}' is on ${source}. Switch to the branch that should receive the merge first.`;
  }
  if (state.pendingChanges > 0) {
    return `'${state.name}' has ${plural(state.pendingChanges, "pending change")}. ` +
      "Check them in, shelve them or undo them, then merge again.";
  }
  if (state.hasIncomingChanges) {
    return `'${state.name}' is not on the latest changeset of ${state.config.location}. ` +
      "Update the workspace, then merge again.";
  }
  return undefined;
}

/** What to do with a preview. */
export type MergePlan =
  | { readonly kind: "nothing"; readonly message: string }
  | { readonly kind: "merge"; readonly message: string; readonly detail: string };

export function planMerge(source: string, destination: string, preview: IMergeReport): MergePlan {
  const changes = preview.incoming + preview.changedOnBoth.length + preview.other.length +
    preview.directoryConflicts.length;
  if (changes === 0) {
    return {
      kind: "nothing",
      message: `There is nothing to merge from ${source} into ${destination}` +
        (preview.nothingToMerge ? ` (cm: ${preview.nothingToMerge}).` : "."),
    };
  }

  const lines = [`${plural(changes, "item")} to merge.`];
  if (preview.directoryConflicts.length > 0) {
    lines.push(
      `${plural(preview.directoryConflicts.length, "directory conflict")}: ` +
      "you choose how to resolve each one next, before anything changes.");
  }
  if (preview.changedOnBoth.length > 0) {
    lines.push(
      `${plural(preview.changedOnBoth.length, "file")} changed on both branches. Where the changes overlap, ` +
      "the file gets conflict markers for you to resolve in the editor.");
  }
  lines.push(
    "The result is left as pending changes with the merge link. Review it and check it in from Source Control.");
  return { detail: lines.join("\n\n"), kind: "merge", message: `Merge ${source} into ${destination}?` };
}

/** One way to answer a directory conflict, as the picker shows it. */
export interface IDirectoryChoice extends QuickPickItem {
  readonly keep: "source" | "destination" | "both";
}

/** cm accepted `rename` for these kinds and refused it for a change/delete (cm 11.0.16). */
const RENAMABLE_CONFLICTS: readonly string[] = ["EVIL"];

export function directoryChoices(
    conflict: IDirectoryConflict, source: string, destination: string): IDirectoryChoice[] {
  const choices: IDirectoryChoice[] = [
    { description: conflict.source, keep: "source", label: `$(arrow-down) Take ${source}` },
    { description: conflict.destination, keep: "destination", label: `$(circle-slash) Keep ${destination}` },
  ];
  if (RENAMABLE_CONFLICTS.includes(conflict.type)) {
    choices.push({
      description: `rename the item on ${destination}, then take the one from ${source}`,
      keep: "both",
      label: "$(files) Keep both",
    });
  }
  return choices;
}

/** The name of the item a conflict side is about: `Added /src/a.txt` is `a.txt`. */
export function conflictItemName(side: string): string {
  const start = side.indexOf("/");
  return start < 0 ? "" : path.posix.basename(side.substring(start));
}

/** The reason `name` cannot replace `current` in a "keep both" answer, or undefined when it can. */
export function renameProblem(name: string, current: string): string | undefined {
  if (name.trim().length === 0) {
    return "Enter a name.";
  }
  if (name !== name.trim() || /[/\\"\r\n]/.test(name) || name.startsWith("-")) {
    return "A name cannot contain slashes, quotes or line breaks, start with '-', or start or end with a space.";
  }
  return name === current ? "Enter a name different from the current one." : undefined;
}

/** How the merge itself ended. */
export type MergeOutcome =
  | { readonly kind: "merged"; readonly message: string }
  /** Text files with conflict markers: resolved in the editor. */
  | { readonly kind: "conflicts"; readonly message: string; readonly paths: readonly string[] }
  /** Files cm cannot merge as text: one branch's version has to be chosen for all of them. */
  | { readonly kind: "undecided"; readonly message: string; readonly detail: string }
  /** cm stopped after changing the workspace, without naming a file. */
  | { readonly kind: "failed"; readonly message: string };

export function describeMergeResult(source: string, destination: string, result: IMergeResult): MergeOutcome {
  if (result.succeeded) {
    return {
      kind: "merged",
      message: `Merged ${source} into ${destination}. Review the pending changes and check them in.`,
    };
  }

  const undecided = result.report.unresolved.filter(file => file.reason !== "markers");
  if (undecided.length > 0) {
    return {
      detail: listed(undecided.map(file => `${file.path} (${file.reason})`)) +
        `\n\nThey changed on both branches and cannot be merged as text. Take the versions of ${source}, ` +
        `or keep the ones of ${destination}: the choice applies to all of them. Cancel aborts the merge.`,
      kind: "undecided",
      message: `${plural(undecided.length, "file")} cannot be merged automatically.`,
    };
  }

  const paths = result.report.unresolved.map(file => file.path);
  if (paths.length > 0) {
    return {
      kind: "conflicts",
      message: `Merged ${source} into ${destination} with conflicts in ${plural(paths.length, "file")}. ` +
        "Resolve the markers and save, then check in.",
      paths,
    };
  }

  return {
    kind: "failed",
    message: `cm stopped while merging ${source} into ${destination}, and part of the merge is in the pending ` +
      `changes. ${result.error?.message ?? ""}`.trim(),
  };
}

/** The check-in comment offered after a merge. */
export function mergeComment(source: string, destination: string): string {
  return `Merge ${source} into ${destination}`;
}

async function makeResolutionFiles(): Promise<{ files: IMergeResolutionFiles; dispose(): Promise<void> }> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "plastic-merge-"));
  return {
    dispose: () => fs.promises.rm(directory, { force: true, recursive: true }),
    files: { resultFile: path.join(directory, "result"), solvedFile: path.join(directory, "solved") },
  };
}

/**
 * Merge commands: merge a branch into the workspace's branch, and what a merge
 * that is not checked in yet needs (open its conflicts, mark one resolved, abort it).
 */
export class MergeCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mDisposables: Disposable[];
  /** The comment each merge put in the check-in box, to take it back when the merge is aborted. */
  private readonly mOfferedComments = new Map<string, string>();

  public constructor(plasticScm: PlasticScm) {
    this.mPlasticScm = plasticScm;
    this.mDisposables = [
      commands.registerCommand(MERGE_COMMANDS.fromBranch, (...args: unknown[]) => this.mergeFromBranch(args)),
      commands.registerCommand(MERGE_COMMANDS.abort, (...args: unknown[]) => this.abort(args)),
      commands.registerCommand(MERGE_COMMANDS.openConflicts, (...args: unknown[]) => this.openConflicts(args)),
      commands.registerCommand(MERGE_COMMANDS.markResolved, (...args: unknown[]) => this.markResolved(args)),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async mergeFromBranch(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Which workspace should receive the merge?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Merge", async () => {
      const source = branchFromNode(args[0])?.name
        ?? explorerChangesetFromArg(args[0])?.branch
        ?? (await pickBranch(workspace.shell, {
          title: "Merge from Branch",
          workspaceConfig: workspace.workspaceConfig,
        }))?.name;
      if (source) {
        await this.merge(workspace, source);
      }
    });
  }

  private async merge(workspace: Workspace, source: string): Promise<void> {
    if (!workspace.operations.isIdle()) {
      void window.showInformationMessage(
        `Plastic SCM: wait for the running operation in '${workspace.info.name}' to finish, then try again.`);
      return;
    }

    // Judged on a fresh status: Abort Merge relies on the merge starting from a clean workspace.
    await workspace.updateWorkspaceStatus();
    const obstacle = mergeObstacle(source, {
      config: workspace.workspaceConfig,
      hasIncomingChanges: workspace.hasIncomingChanges,
      name: workspace.info.name,
      pendingChanges: countPendingChanges(workspace.pendingChanges),
    });
    if (obstacle) {
      void window.showWarningMessage(obstacle);
      return;
    }
    const destination = workspace.workspaceConfig?.location ?? "";

    const preview = await Merge.preview(workspace.shell, source);
    const plan = planMerge(source, destination, preview);
    if (plan.kind === "nothing") {
      void window.showInformationMessage(plan.message);
      return;
    }

    const merge = "Merge";
    if (await window.showInformationMessage(plan.message, { detail: plan.detail, modal: true }, merge) !== merge) {
      return;
    }

    if (preview.directoryConflicts.length === 0) {
      await this.runMerge(workspace, source, destination);
      return;
    }

    const resolutions = await makeResolutionFiles();
    try {
      if (await this.answerDirectoryConflicts(
        workspace, source, destination, preview.directoryConflicts, resolutions.files)) {
        await this.runMerge(workspace, source, destination, resolutions.files);
      }
    } finally {
      await resolutions.dispose();
    }
  }

  /**
   * Asks about each directory conflict and records the answer with cm, which
   * changes nothing in the workspace. False when the user backed out.
   */
  private async answerDirectoryConflicts(
      workspace: Workspace,
      source: string,
      destination: string,
      conflicts: readonly IDirectoryConflict[],
      files: IMergeResolutionFiles): Promise<boolean> {

    let open = conflicts;
    while (open.length > 0) {
      const conflict = open[0];
      const choice = await window.showQuickPick(directoryChoices(conflict, source, destination), {
        ignoreFocusOut: true,
        placeHolder: `${conflict.source} on ${source}, ${conflict.destination} on ${destination}. ` +
          "Escape cancels the merge; nothing has changed yet.",
        title: `${conflict.title} (${open.length} to decide)`,
      });
      if (!choice) {
        return false;
      }

      let resolution: DirectoryResolution;
      if (choice.keep === "both") {
        const current = conflictItemName(conflict.destination);
        const name = await window.showInputBox({
          ignoreFocusOut: true,
          prompt: `New name for ${current || "the item"} on ${destination}. ` +
            `The one from ${source} then takes its place.`,
          title: conflict.title,
          validateInput: text => renameProblem(text, current),
          value: current,
        });
        if (name === undefined) {
          continue;
        }
        resolution = { keep: "both", name };
      } else {
        resolution = { keep: choice.keep };
      }

      // cm numbers the conflicts still open from 1, so the one asked about is always the first.
      const left = (await Merge.resolveDirectoryConflict(workspace.shell, source, 1, resolution, files))
        .directoryConflicts;
      if (left.length >= open.length) {
        throw new Error(`cm did not take the answer to '${conflict.title}'. Nothing was changed.`);
      }
      open = left;
    }
    return true;
  }

  private async runMerge(
      workspace: Workspace, source: string, destination: string, resolutions?: IMergeResolutionFiles): Promise<void> {

    const run = (keep?: "source" | "destination") => runWorkspaceOperation(
      this.mPlasticScm,
      workspace,
      { name: "Merge", operation: WorkspaceOperation.Merge, title: `Merging ${source} into ${destination}` },
      async () => describeMergeResult(
        source, destination, await Merge.run(workspace.shell, source, { keep, resolutions })));

    let finished = await run();
    if (finished.status !== "succeeded") {
      return;
    }

    let outcome = finished.result;
    if (outcome.kind === "undecided") {
      const takeSource = `Take ${source}`;
      const keepDestination = `Keep ${destination}`;
      const answer = await window.showWarningMessage(
        outcome.message, { detail: outcome.detail, modal: true }, takeSource, keepDestination);
      if (answer === undefined) {
        await this.undoMerge(workspace);
        return;
      }

      finished = await run(answer === takeSource ? "source" : "destination");
      if (finished.status !== "succeeded") {
        return;
      }
      outcome = finished.result;
    }

    switch (outcome.kind) {
    case "merged":
      this.offerComment(workspace, source, destination);
      this.mPlasticScm.channel.appendLine(`Merged br:${source} into '${workspace.info.name}'`);
      void window.showInformationMessage(outcome.message);
      void commands.executeCommand("workbench.view.scm");
      return;
    case "conflicts":
      this.offerComment(workspace, source, destination);
      await this.showConflicts(workspace, outcome.message, outcome.paths);
      return;
    case "undecided":
    case "failed": {
      const message = outcome.kind === "failed"
        ? outcome.message
        : `${outcome.message} cm left them as they were even after choosing a side. ` +
          "Abort the merge and do it in the Plastic SCM GUI.";
      if (await window.showErrorMessage(message, { modal: true }, ABORT) === ABORT) {
        await this.undoMerge(workspace);
      }
      return;
    }
    }
  }

  /** Fills the check-in box when it is empty, so the merge changeset does not go in without a comment. */
  private offerComment(workspace: Workspace, source: string, destination: string): void {
    const inputBox = workspace.sourceControl.inputBox;
    if (inputBox.value.trim().length === 0) {
      inputBox.value = mergeComment(source, destination);
      this.mOfferedComments.set(workspace.info.id, inputBox.value);
    }
  }

  /** Opens the first conflicting file, where VS Code offers its conflict actions, and points at the rest. */
  private async showConflicts(workspace: Workspace, message: string, serverPaths: readonly string[]): Promise<void> {
    const conflicts = workspace.mergeConflicts.length > 0
      ? workspace.mergeConflicts
      : serverPaths.map(serverPath => Uri.file(path.join(workspace.info.path, serverPath)));
    if (conflicts.length > 0) {
      await window.showTextDocument(conflicts[0], { preview: false });
    }

    const showAll = "Show Conflicts";
    void window.showWarningMessage(message, showAll, ABORT).then(answer => {
      if (answer === showAll) {
        void commands.executeCommand("workbench.view.scm");
      } else if (answer === ABORT) {
        void commands.executeCommand(MERGE_COMMANDS.abort, workspace);
      }
    });
  }

  private async openConflicts(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Open the merge conflicts of which workspace?");
    if (!workspace) {
      return;
    }

    const conflicts = workspace.mergeConflicts;
    if (conflicts.length === 0) {
      void window.showInformationMessage(`No file in '${workspace.info.name}' has merge conflict markers.`);
      return;
    }

    const picked = conflicts.length === 1 ? conflicts[0] : (await window.showQuickPick(
      conflicts.map(uri => ({ label: path.relative(workspace.info.path, uri.fsPath), uri })),
      {
        placeHolder: `${plural(conflicts.length, "file")} with merge conflict markers`,
        title: "Merge Conflicts",
      }))?.uri;
    if (picked) {
      await window.showTextDocument(picked, { preview: false });
    }
  }

  private async markResolved(args: unknown[]): Promise<void> {
    const first = args[0] as { resourceUri?: unknown } | undefined;
    const uri = first?.resourceUri instanceof Uri ? first.resourceUri : undefined;
    const workspace = uri && Array.from(this.mPlasticScm.workspaces.values()).find(
      candidate => candidate.mergeConflicts.some(conflict => conflict.fsPath === uri.fsPath));
    if (!uri || !workspace) {
      return;
    }

    const name = path.relative(workspace.info.path, uri.fsPath);
    const mark = "Mark as Resolved";
    const answer = await window.showWarningMessage(
      `Mark ${name} as resolved?`,
      {
        detail: "cm stops checking it for conflict markers, so it can be checked in with marker text in it. " +
          "A file you resolved and saved needs no marking.",
        modal: true,
      },
      mark);
    if (answer !== mark) {
      return;
    }

    await runWorkspaceOperation(
      this.mPlasticScm,
      workspace,
      { name: "Mark as Resolved", operation: WorkspaceOperation.Merge, title: `Marking ${name} as resolved` },
      () => Merge.markResolved(workspace.shell, [uri.fsPath]));
  }

  private async abort(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Abort the merge of which workspace?");
    if (!workspace) {
      return;
    }

    if (!workspace.isMerging) {
      void window.showInformationMessage(`'${workspace.info.name}' has no merge waiting to be checked in.`);
      return;
    }

    const count = countPendingChanges(workspace.pendingChanges);
    const answer = await window.showWarningMessage(
      `Abort the merge in '${workspace.info.name}'?`,
      {
        detail: `This undoes all ${plural(count, "pending change")} of the workspace (cm undo -r): the merge, ` +
          "the conflicts you already resolved and anything else you changed since. Private files are kept. " +
          "It cannot be brought back.",
        modal: true,
      },
      ABORT);
    if (answer === ABORT) {
      await this.undoMerge(workspace);
    }
  }

  private async undoMerge(workspace: Workspace): Promise<void> {
    const outcome = await runWorkspaceOperation(
      this.mPlasticScm,
      workspace,
      { name: ABORT, operation: WorkspaceOperation.Merge, title: `Aborting the merge in ${workspace.info.name}` },
      () => Undo.run(workspace.shell, true, workspace.info.path));
    if (outcome.status !== "succeeded") {
      return;
    }

    const inputBox = workspace.sourceControl.inputBox;
    if (inputBox.value === this.mOfferedComments.get(workspace.info.id)) {
      inputBox.value = "";
    }
    this.mOfferedComments.delete(workspace.info.id);
    window.setStatusBarMessage("Merge aborted: the workspace is as it was", 5000);
  }
}
