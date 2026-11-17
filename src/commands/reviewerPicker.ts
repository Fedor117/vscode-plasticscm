import { Disposable, QuickInputButton, QuickPickItem, QuickPickItemKind, ThemeIcon, window } from "vscode";
import { IReviewerNames, IServerMember, reviewerNameProblem } from "../cm/commands";

/** The prefix that names a group in a reviewers box: `group:Developers`. */
export const GROUP_PREFIX = "group:";

/** A user or a group, by the name cm knows. */
export interface IReviewerRef {
  name: string;
  type: "user" | "group";
}

/** A reviewer to pick; a row without `reviewer` (a separator, `All reviewers`) names nobody. */
export interface IReviewerItem extends QuickPickItem {
  readonly reviewer?: IReviewerRef;
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

/** What {@link parseReviewerNames} reads back as `names`. */
export function formatReviewerNames(names: IReviewerNames): string {
  return [ ...(names.users ?? []), ...(names.groups ?? []).map(group => `${GROUP_PREFIX}${group}`) ].join(", ");
}

/** Users and groups of picked reviewer rows. */
export function namesOf(items: readonly IReviewerItem[]): IReviewerNames {
  const of = (type: "user" | "group") => items
    .filter(item => item.reviewer?.type === type).map(item => item.reviewer?.name ?? "");
  return { groups: of("group"), users: of("user") };
}

/**
 * The groups Unity Version Control Cloud makes for a project's roles, named
 * `<project guid>-ro|rw|admin`. Nobody can tell them apart by name, and an
 * organization has three per project.
 */
const PROJECT_ROLE_GROUP = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-(?:ro|rw|admin)$/i;

/**
 * The server's users and groups as rows to check: groups first, each kind by
 * name. Left out: whoever is in `already`, project role groups, and names cm
 * cannot take in a list.
 */
export function candidateItems(
    members: readonly IServerMember[], already: readonly IReviewerRef[] = []): IReviewerItem[] {
  const key = (member: IReviewerRef) => `${member.type}:${member.name.toLowerCase()}`;
  const taken = new Set(already.map(key));
  const rows = (type: "user" | "group", heading: string): IReviewerItem[] => {
    const listed = members
      .filter(member => member.type === type && !taken.has(key(member)) && !reviewerNameProblem(member.name)
        && !(type === "group" && PROJECT_ROLE_GROUP.test(member.name)))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
      .map(member => ({
        description: type === "group" ? "group" : undefined,
        label: member.name,
        reviewer: { name: member.name, type },
      }));
    return listed.length ? [{ kind: QuickPickItemKind.Separator, label: heading }, ...listed ] : [];
  };
  return [ ...rows("group", "Groups"), ...rows("user", "Users") ];
}

export interface IReviewerPick {
  title?: string;
  placeHolder: string;
  /** What the box that takes typed names asks. */
  prompt: string;
  /** Whether nobody is an answer; otherwise accepting nobody cancels. */
  optional: boolean;
}

const TYPE_NAMES: QuickInputButton = { iconPath: new ThemeIcon("edit"), tooltip: "Type Names Instead" };

/**
 * Asks for reviewers: the rows of `loading` to check, filtered by typing.
 * The title bar's pencil takes typed names instead, starting from the checked
 * rows, for someone the list lacks; so does a list that is empty or failed to
 * load. Undefined when cancelled; no names when `optional` and nobody was picked.
 */
export async function pickReviewers(
    loading: Promise<IReviewerItem[]>, options: IReviewerPick): Promise<IReviewerNames | undefined> {
  const picker = window.createQuickPick<IReviewerItem>();
  picker.title = options.title;
  picker.placeholder = options.placeHolder;
  picker.canSelectMany = true;
  picker.ignoreFocusOut = true;
  picker.matchOnDescription = true;
  picker.buttons = [TYPE_NAMES];
  picker.busy = true;

  const subscriptions: Disposable[] = [];
  const answer = await new Promise<{ checked: IReviewerNames; type: boolean } | undefined>(resolve => {
    const checked = () => namesOf(picker.selectedItems);
    subscriptions.push(
      picker.onDidAccept(() => resolve({ checked: checked(), type: false })),
      picker.onDidTriggerButton(() => resolve({ checked: checked(), type: true })),
      picker.onDidHide(() => resolve(undefined)));
    picker.show();
    loading.then(items => {
      if (!items.length) {
        resolve({ checked: {}, type: true });
        return;
      }
      picker.items = items;
      picker.busy = false;
    }, () => resolve({ checked: {}, type: true }));
  }).finally(() => {
    Disposable.from(...subscriptions, picker).dispose();
  });

  const picked = answer?.type ? await typeReviewers(options, formatReviewerNames(answer.checked)) : answer?.checked;
  const nobody = picked && !picked.users?.length && !picked.groups?.length;
  return nobody && !options.optional ? undefined : picked;
}

async function typeReviewers(options: IReviewerPick, value: string): Promise<IReviewerNames | undefined> {
  const text = await window.showInputBox({
    ignoreFocusOut: true,
    placeHolder: "someone@example.com, group:Developers",
    prompt: options.prompt,
    title: options.title,
    validateInput: entered => (options.optional && !entered.trim() ? undefined : parseReviewerNames(entered).problem),
    value,
  });
  if (text === undefined) {
    return undefined;
  }
  return text.trim() ? parseReviewerNames(text).names : {};
}
