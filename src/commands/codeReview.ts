import { branchFromNode, explorerChangesetFromArg, guarded, resolveWorkspace } from "./targets";
import { CodeReview, IListedReviewer, IReviewerNames, reviewerNameProblem, reviewTitleProblem } from "../cm/commands";
import { commands, Disposable, QuickPickItem, window } from "vscode";
import { pickBranch, pickChangeset } from "../repository/pickers";
import { runWorkspaceOperation, WorkspaceOperation } from "../workspaceOperations";
import { firstLine } from "../repository/presentation";
import { PlasticScm } from "../plasticScm";
import { WkConfigType } from "../models";
import { Workspace } from "../workspace";

export const CODE_REVIEW_COMMANDS = {
  addReviewers: "plastic-scm.codeReview.addReviewers",
  create: "plastic-scm.codeReview.create",
  removeReviewers: "plastic-scm.codeReview.removeReviewers",
  requestReviewAgain: "plastic-scm.codeReview.requestReviewAgain",
};

/** The prefix that names a group in a reviewers box: `group:Developers`. */
export const GROUP_PREFIX = "group:";

/** The review a reviewer command acts on. */
export interface IReviewRef {
  workspaceId: string;
  id: number;
  title: string;
  owner: string;
}

/** A reviewer to pick: a user or a group, by the name cm knows; `all` is every reviewer. */
export interface IReviewerItem extends QuickPickItem {
  readonly reviewer?: { name: string; type: "user" | "group" };
}

/**
 * `alice@example.com, group:Developers` as users and groups; a reason instead
 * when a name cannot be passed to cm or nothing was named.
 */
export function parseReviewerNames(text: string): { names?: IReviewerNames; problem?: string } {
  const users: string[] = [];
  const groups: string[] = [];
  for (const part of text.split(",").map(entry => entry.trim()).filter(Boolean)) {
    const group = part.toLowerCase().startsWith(GROUP_PREFIX);
    const name = group ? part.substring(GROUP_PREFIX.length).trim() : part;
    const problem = reviewerNameProblem(name);
    if (problem) {
      return { problem: `${part}: ${problem}` };
    }
    (group ? groups : users).push(name);
  }
  return users.length || groups.length ? { names: { groups, users }} : { problem: "Name at least one reviewer." };
}

/** The rows of `cm codereview reviewer list`, to pick from. */
export function reviewerItems(listed: readonly IListedReviewer[]): IReviewerItem[] {
  return listed.map(row => ({
    description: [ row.type === "group" ? "group" : "", row.status ].filter(Boolean).join(" · "),
    label: row.name,
    reviewer: { name: row.name, type: row.type },
  }));
}

/** Users and groups of picked reviewer rows. */
export function namesOf(items: readonly IReviewerItem[]): IReviewerNames {
  const of = (type: "user" | "group") => items
    .filter(item => item.reviewer?.type === type).map(item => item.reviewer?.name ?? "");
  return { groups: of("group"), users: of("user") };
}

/** `alice@example.com and the group Developers`, for a message. */
export function describeReviewers(names: IReviewerNames): string {
  const parts = [ ...(names.users ?? []), ...(names.groups ?? []).map(group => `the group ${group}`) ];
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A Reviews row's review, as Plastic Reviews hands it to a row command; undefined for anything else. */
export function reviewRefFromArg(arg: unknown): IReviewRef | undefined {
  const row = arg as { kind?: unknown; workspaceId?: unknown; review?: Partial<IReviewRef> } | null | undefined;
  const review = row?.review;
  return row?.kind === "review" && typeof row.workspaceId === "string" && typeof review?.id === "number"
    && Number.isInteger(review.id)
    ? {
      id: review.id,
      owner: typeof review.owner === "string" ? review.owner : "",
      title: typeof review.title === "string" ? review.title : "",
      workspaceId: row.workspaceId,
    }
    : undefined;
}

/** What a new review is about: `spec` for cm, and words for the dialogs. */
export interface IReviewTarget {
  spec: string;
  description: string;
  /** What the title box starts with. */
  suggestedTitle: string;
}

interface ITargetItem extends QuickPickItem {
  pick: "current" | "branch" | "changeset";
}

const OPEN_REVIEW = "Open Review";

/** A branch as a review target: `br:/main/task`, titled after its last segment. */
export function branchTarget(name: string): IReviewTarget {
  const short = name.substring(name.lastIndexOf("/") + 1) || name;
  return { description: `branch ${name}`, spec: `br:${name}`, suggestedTitle: short };
}

/** A changeset as a review target, titled after the first line of its comment. */
export function changesetTarget(id: number, comment: string): IReviewTarget {
  return { description: `cs:${id}`, spec: `cs:${id}`, suggestedTitle: firstLine(comment).replace(/"/g, "'") };
}

/**
 * Create Code Review…: from a Repository branch row, or from the current
 * branch, a picked branch or a picked changeset; then a title, an optional
 * description and optional reviewers. Runs the documented
 * `cm codereview <spec> <title>`, and offers to open the new review in
 * Plastic Reviews.
 *
 * Add Reviewers…, Remove Reviewers… and Request Review Again… act on a
 * Reviews row's review or else the open review, with `cm codereview reviewer`
 * and `cm codereview review --re-request`, on the workspace's own cm shell.
 */
export class CodeReviewCommands implements Disposable {
  private readonly mPlasticScm: PlasticScm;
  private readonly mActiveReview: () => IReviewRef | undefined;
  private readonly mDisposables: Disposable[];

  public constructor(plasticScm: PlasticScm, activeReview: () => IReviewRef | undefined = () => undefined) {
    this.mPlasticScm = plasticScm;
    this.mActiveReview = activeReview;
    const onReview = (id: string, name: string, action: (workspace: Workspace, review: IReviewRef) => Promise<void>) =>
      commands.registerCommand(id, (arg: unknown) => this.runOnReview(arg, name, action));
    this.mDisposables = [
      commands.registerCommand(CODE_REVIEW_COMMANDS.create, (...args: unknown[]) => this.create(args)),
      onReview(CODE_REVIEW_COMMANDS.addReviewers, "Add Reviewers",
        (workspace, review) => this.addReviewers(workspace, review)),
      onReview(CODE_REVIEW_COMMANDS.removeReviewers, "Remove Reviewers",
        (workspace, review) => this.removeReviewers(workspace, review)),
      onReview(CODE_REVIEW_COMMANDS.requestReviewAgain, "Request Review Again",
        (workspace, review) => this.requestReviewAgain(workspace, review)),
    ];
  }

  public dispose(): void {
    Disposable.from(...this.mDisposables).dispose();
    this.mDisposables.length = 0;
  }

  private async create(args: unknown[]): Promise<void> {
    const workspace = await resolveWorkspace(this.mPlasticScm, args, "Create a code review in which workspace?");
    if (!workspace) {
      return;
    }

    await guarded(this.mPlasticScm, "Create Code Review", async () => {
      const target = await this.chooseTarget(workspace, args[0]);
      if (!target) {
        return;
      }
      const title = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: `Title of the code review of ${target.description}`,
        title: "Create Code Review",
        validateInput: text => reviewTitleProblem(text),
        value: target.suggestedTitle,
      });
      if (title === undefined) {
        return;
      }
      const description = await window.showInputBox({
        ignoreFocusOut: true,
        prompt: "Description (optional). Enter to continue without one.",
        title: "Create Code Review",
      });
      if (description === undefined) {
        return;
      }
      const reviewerText = await window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: "someone@example.com, group:Developers",
        prompt: "Reviewers (optional): user names separated by commas, groups as group:<name>.",
        title: "Create Code Review",
        validateInput: text => (text.trim() ? parseReviewerNames(text).problem : undefined),
      });
      if (reviewerText === undefined) {
        return;
      }
      const reviewers: IReviewerNames = reviewerText.trim() ? parseReviewerNames(reviewerText).names ?? {} : {};
      if (description.trim() && !(await CodeReview.support(workspace.shell)).descriptionFile) {
        throw new Error("This cm can't read a review description from a file. Update Unity Version Control, or " +
          "leave the description empty.");
      }

      const outcome = await runWorkspaceOperation(
        this.mPlasticScm,
        workspace,
        {
          name: "Create Code Review",
          operation: WorkspaceOperation.Reference,
          refreshStatus: false,
          title: `Creating a code review of ${target.description}`,
        },
        () => CodeReview.create(workspace.shell, this.mPlasticScm.channel,
          { description, reviewers, spec: target.spec, title }));
      if (outcome.status !== "succeeded") {
        return;
      }
      await commands.executeCommand("plastic-scm.reviews.refresh");
      const id = outcome.result.id;
      if (id === undefined) {
        void window.showInformationMessage(`Created a code review of ${target.description}. Refresh Plastic Reviews ` +
          "to see it.");
        return;
      }
      const choice = await window.showInformationMessage(
        `Created code review #${id} of ${target.description}.`, OPEN_REVIEW);
      if (choice === OPEN_REVIEW) {
        await commands.executeCommand("plastic-scm.reviews.open", workspace.info.id, id);
        await commands.executeCommand("plastic-scm.reviews.openOverview");
      }
    });
  }

  private async runOnReview(
      arg: unknown,
      name: string,
      action: (workspace: Workspace, review: IReviewRef) => Promise<void>): Promise<void> {
    const review = reviewRefFromArg(arg) ?? this.mActiveReview();
    const workspace = review && this.mPlasticScm.workspaces.get(review.workspaceId);
    if (!review || !workspace) {
      void window.showInformationMessage("Open a review in Plastic Reviews first.");
      return;
    }
    await guarded(this.mPlasticScm, name, async () => {
      const support = await CodeReview.support(workspace.shell);
      if (!support.reviewers || !support.review) {
        void window.showInformationMessage("Managing reviewers needs a cm client with 'cm codereview reviewer' and " +
          "'cm codereview review'. Update Unity Version Control to use it from VS Code.");
        return;
      }
      await action(workspace, review);
    });
  }

  private async addReviewers(workspace: Workspace, review: IReviewRef): Promise<void> {
    const text = await window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "someone@example.com, group:Developers",
      prompt: `Reviewers to add to review #${review.id}: user names separated by commas, groups as ` +
        `${GROUP_PREFIX}<name>`,
      validateInput: value => parseReviewerNames(value).problem,
    });
    const names = text === undefined ? undefined : parseReviewerNames(text).names;
    if (!names) {
      return;
    }
    await this.writeReviewers(workspace, review, `Adding reviewers to review #${review.id}`,
      () => CodeReview.addReviewers(workspace.shell, review.id, names),
      `Added ${describeReviewers(names)} to review #${review.id}`);
  }

  private async removeReviewers(workspace: Workspace, review: IReviewRef): Promise<void> {
    const picked = await window.showQuickPick(this.listReviewers(workspace, review), {
      canPickMany: true,
      placeHolder: `Reviewers to remove from review #${review.id}`,
    });
    if (!picked?.length) {
      return;
    }
    const names = namesOf(picked);
    const confirmed = await window.showWarningMessage(
      `Remove ${describeReviewers(names)} from the reviewers of review #${review.id}?`,
      { detail: `"${review.title}". Their earlier verdicts stay in the review's history.`, modal: true },
      "Remove");
    if (confirmed !== "Remove") {
      return;
    }
    await this.writeReviewers(workspace, review, `Removing reviewers from review #${review.id}`,
      () => CodeReview.removeReviewers(workspace.shell, review.id, names),
      `Removed ${describeReviewers(names)} from review #${review.id}`);
  }

  private async requestReviewAgain(workspace: Workspace, review: IReviewRef): Promise<void> {
    const all: IReviewerItem = { description: "every reviewer", label: "$(people) All reviewers" };
    const items: Promise<IReviewerItem[]> = this.listReviewers(workspace, review).then(listed => [ all, ...listed ]);
    const picked = await window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Whom to ask to review #${review.id} again`,
    });
    if (!picked?.length) {
      return;
    }
    const who = picked.includes(all) ? "all" as const : namesOf(picked);
    await this.writeReviewers(workspace, review, `Asking for review #${review.id} again`,
      () => CodeReview.reRequest(workspace.shell, review.id, who),
      `Asked ${who === "all" ? "all reviewers" : describeReviewers(who)} to review #${review.id} again`);
  }

  private async listReviewers(workspace: Workspace, review: IReviewRef): Promise<IReviewerItem[]> {
    return reviewerItems(await CodeReview.listReviewers(workspace.shell, review.id));
  }

  /** Runs a reviewer write with progress, says what happened and reloads the open review when it is the one. */
  private async writeReviewers(
      workspace: Workspace,
      review: IReviewRef,
      title: string,
      action: () => Promise<unknown>,
      done: string): Promise<void> {
    const outcome = await runWorkspaceOperation(
      this.mPlasticScm,
      workspace,
      { name: "Reviewers", operation: WorkspaceOperation.Reference, refreshStatus: false, title },
      action);
    if (outcome.status !== "succeeded") {
      return;
    }
    window.setStatusBarMessage(`$(check) ${done}`, 4000);
    const active = this.mActiveReview();
    if (active && active.workspaceId === review.workspaceId && active.id === review.id) {
      await commands.executeCommand("plastic-scm.reviews.refreshReview");
    }
  }

  /** A branch row's branch; otherwise the current branch, a picked branch or a picked changeset. */
  private async chooseTarget(workspace: Workspace, arg: unknown): Promise<IReviewTarget | undefined> {
    const row = branchFromNode(arg);
    if (row) {
      return branchTarget(row.name);
    }
    const explorerRow = explorerChangesetFromArg(arg);
    if (explorerRow) {
      return branchTarget(explorerRow.branch);
    }

    const config = workspace.workspaceConfig;
    const current = config?.configType === WkConfigType.Branch ? config.location : undefined;
    const items: ITargetItem[] = [
      ...(current
        ? [{ description: current, label: "$(git-branch) The current branch", pick: "current" as const }]
        : []),
      { label: "$(list-tree) A branch…", pick: "branch" },
      { label: "$(git-commit) A changeset…", pick: "changeset" },
    ];
    const choice = await window.showQuickPick(items, { placeHolder: "Review…", title: "Create Code Review" });
    switch (choice?.pick) {
    case "current":
      return current ? branchTarget(current) : undefined;
    case "branch": {
      const branch = await pickBranch(workspace.shell, {
        placeHolder: "Branch to review", title: "Create Code Review", workspaceConfig: config,
      });
      return branch && branchTarget(branch.name);
    }
    case "changeset": {
      const changeset = await pickChangeset(workspace.shell, {
        placeHolder: "Changeset to review", title: "Create Code Review", workspaceConfig: config,
      });
      return changeset && changesetTarget(changeset.id, changeset.comment);
    }
    default:
      return undefined;
    }
  }
}
