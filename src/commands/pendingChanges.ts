import { window } from "vscode";
import { Workspace } from "../workspace";

/** What is about to run over the pending changes. */
export interface IPendingChangesAction {
  readonly kind: "switch" | "update";
  /** Where it goes, e.g. `branch /main/task001`; shown in the dialog. */
  readonly target: string;
}

/**
 * A way out of the pending-changes dialog besides cancelling or continuing,
 * shown as one more button. The Shelves slice adds "Shelve changes and
 * switch" by pushing one onto {@link PENDING_CHANGES_HANDLERS}.
 */
export interface IPendingChangesHandler {
  /** Button text. */
  readonly label: string;
  /** What choosing the button does, in a sentence; shown in the dialog's detail. */
  readonly detail?: string;
  /**
   * Deals with the pending changes (e.g. shelves and undoes them). Resolves true
   * to carry on with the switch or update, false to stop; a rejection stops it
   * and is reported as the operation's error.
   */
  run(workspace: Workspace, action: IPendingChangesAction): Promise<boolean>;
}

/**
 * Something to do once the switch or update that a handler cleared the way for
 * has finished (e.g. tell the user which shelve holds their changes). Taken
 * once, by whichever switch or update runs next in that workspace.
 */
export type PendingChangesFollowUp = (succeeded: boolean) => Promise<void> | void;

const followUps = new Map<string, PendingChangesFollowUp>();

/** For a handler: run `followUp` when the switch or update that follows has finished. */
export function setPendingChangesFollowUp(workspace: Pick<Workspace, "info">, followUp: PendingChangesFollowUp): void {
  followUps.set(workspace.info.id, followUp);
}

/** Runs and forgets the workspace's follow-up, if a handler left one. */
export async function runPendingChangesFollowUp(
    workspace: Pick<Workspace, "info">, succeeded: boolean): Promise<void> {
  const followUp = followUps.get(workspace.info.id);
  followUps.delete(workspace.info.id);
  if (followUp) {
    await followUp(succeeded);
  }
}

/** Extension point: empty until another feature offers a different answer than "continue". */
export const PENDING_CHANGES_HANDLERS: IPendingChangesHandler[] = [];

export const CONTINUE_LABEL = "Continue";

/** Private (untracked) files do not count: a switch or update leaves them alone unless the target has the path. */
export function countPendingChanges(states: ReadonlyArray<{ readonly isPrivate: boolean }>): number {
  return states.filter(state => !state.isPrivate).length;
}

/**
 * What `--noinput` does, as far as `cm help switch` and `cm help update` say:
 * both describe it as skipping the questions about pending changes and
 * "disabling the possibility of bringing your pending changes". Neither says
 * what happens to the changes instead, so the dialog does not promise any.
 */
export function pendingChangesDetail(
    action: IPendingChangesAction,
    handlers: readonly IPendingChangesHandler[]): string {
  const verb = action.kind === "switch" ? "switch" : "update";
  const alternatives = handlers.length > 0
    ? ` Or use ${handlers.map(handler => `"${handler.label}"`).join(" or ")}.`
    : " Check them in or discard them first if you need to be sure of them.";

  const explained = handlers
    .filter(handler => handler.detail)
    .map(handler => `\n\n"${handler.label}": ${handler.detail}`)
    .join("");

  return `Plastic SCM cannot ask here what to do with them, so the ${verb} runs with --noinput. ` +
    "According to cm's help, that skips its questions and disables bringing your pending changes " +
    `along. The help does not say what happens to them instead, so treat them as at risk.${alternatives}${explained}`;
}

type Ask = (message: string, detail: string, buttons: string[]) => Thenable<string | undefined>;

const askWithModal: Ask = (message, detail, buttons) =>
  window.showWarningMessage(message, { detail, modal: true }, ...buttons);

/**
 * Returns true when the action may run: the workspace has no pending changes,
 * the user chose Continue, or a handler dealt with them. False on cancel.
 */
export async function confirmPendingChanges(
    workspace: Workspace,
    action: IPendingChangesAction,
    handlers: readonly IPendingChangesHandler[] = PENDING_CHANGES_HANDLERS,
    ask: Ask = askWithModal): Promise<boolean> {

  // A follow-up left by an earlier dialog that never led to a switch must not fire for this one.
  followUps.delete(workspace.info.id);

  const count = countPendingChanges(workspace.pendingChanges);
  if (count === 0) {
    return true;
  }

  const noun = count === 1 ? "pending change" : "pending changes";
  const verb = action.kind === "switch" ? "Switching to" : "Updating";
  const subject = action.kind === "switch" ? action.target : `'${workspace.info.name}'`;
  const choice = await ask(
    `${verb} ${subject} with ${count} ${noun}?`,
    pendingChangesDetail(action, handlers),
    [ CONTINUE_LABEL, ...handlers.map(handler => handler.label) ]);

  if (choice === undefined) {
    return false;
  }

  const handler = handlers.find(candidate => candidate.label === choice);
  return handler ? handler.run(workspace, action) : choice === CONTINUE_LABEL;
}
