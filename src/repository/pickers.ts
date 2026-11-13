import {
  FindBranch,
  FindChangesets,
  ListBranches,
  ListLabels,
  ListShelves,
} from "../cm/commands";
import {
  firstLine,
  isCurrentBranch,
  isCurrentLabel,
  isCurrentShelve,
  ownerAndDate,
  shelveSpec,
} from "./presentation";
import {
  IBranchInfo,
  IHistoryChangeset,
  ILabelInfo,
  IListPage,
  IShelveInfo,
  IWorkspaceConfig,
} from "../models";
import { QuickPickItem, QuickPickItemKind, window } from "vscode";
import { ICmShell } from "../cm/shell";

/** Rows a picker loads when the caller does not say. */
export const DEFAULT_PICKER_LIMIT = 200;

export interface IPickerOptions {
  /** Title of the picker, e.g. "Switch to Branch". */
  title?: string;
  /** Placeholder of the filter box. */
  placeHolder?: string;
  /**
   * Newest rows to load; the rest are reached by typing a full name or number.
   * Default {@link DEFAULT_PICKER_LIMIT}.
   */
  limit?: number;
  /** The workspace's current location, to mark the row it is on. */
  workspaceConfig?: IWorkspaceConfig;
}

export interface IChangesetPickerOptions extends IPickerOptions {
  /** Full branch name to list changesets of; when absent, the user picks a branch first. */
  branch?: string;
}

/**
 * Picks a branch: the newest branches, filtered as the user types; a full name
 * starting with `/` (or `br:/`) that is not listed is looked up with cm.
 * Resolves undefined when the user cancels; rejects when cm fails.
 */
export function pickBranch(shell: ICmShell, options: IPickerOptions = {}): Promise<IBranchInfo | undefined> {
  const limit = options.limit ?? DEFAULT_PICKER_LIMIT;
  return showPicker<IBranchInfo>({
    key: branch => branch.name,
    load: () => ListBranches.run(shell, { limit }),
    lookup: text => FindBranch.run(shell, text),
    lookupLabel: text => {
      const name = parseBranchName(text);
      return name ? { label: `$(search) Look up branch ${name}`, text: name } : undefined;
    },
    noun: "branch",
    plural: "branches",
    toItem: branch => branchItem(branch, options.workspaceConfig),
  }, { placeHolder: "Type to filter branches, or a full name such as /main/task001", ...options, limit });
}

/** Picks a label; a typed name that is not listed is looked up with cm (exact, case-sensitive). */
export function pickLabel(shell: ICmShell, options: IPickerOptions = {}): Promise<ILabelInfo | undefined> {
  const limit = options.limit ?? DEFAULT_PICKER_LIMIT;
  return showPicker<ILabelInfo>({
    key: label => label.name,
    load: () => ListLabels.run(shell, { limit }),
    lookup: text => ListLabels.runByName(shell, text),
    lookupLabel: text => {
      const name = parseLabelName(text);
      return name ? { label: `$(search) Look up label ${name}`, text: name } : undefined;
    },
    noun: "label",
    plural: "labels",
    toItem: label => labelItem(label, options.workspaceConfig),
  }, { placeHolder: "Type to filter labels, or an exact label name", ...options, limit });
}

/** Picks a shelve; typing `N` or `sh:N` looks that shelve up with cm. */
export function pickShelve(shell: ICmShell, options: IPickerOptions = {}): Promise<IShelveInfo | undefined> {
  const limit = options.limit ?? DEFAULT_PICKER_LIMIT;
  return showPicker<IShelveInfo>({
    key: shelve => String(shelve.shelveId),
    load: () => ListShelves.run(shell, { limit }),
    lookup: text => ListShelves.runById(shell, Number(text)),
    lookupLabel: text => {
      const id = parseObjectNumber(text, "sh");
      return id === undefined ? undefined : { label: `$(search) Look up shelve sh:${id}`, text: String(id) };
    },
    noun: "shelve",
    plural: "shelves",
    toItem: shelve => shelveItem(shelve, options.workspaceConfig),
  }, { placeHolder: "Type to filter shelves, or a shelve number", ...options, limit });
}

/**
 * Picks a changeset of `options.branch` (or of a branch the user picks first);
 * typing `N` or `cs:N` looks up any changeset, on any branch, hidden ones included.
 */
export async function pickChangeset(
    shell: ICmShell, options: IChangesetPickerOptions = {}): Promise<IHistoryChangeset | undefined> {
  const branch = options.branch ?? (await pickBranch(shell, {
    placeHolder: "Pick the branch to choose a changeset from",
    title: options.title,
    workspaceConfig: options.workspaceConfig,
  }))?.name;
  if (!branch) {
    return undefined;
  }

  const limit = options.limit ?? DEFAULT_PICKER_LIMIT;
  return showPicker<IHistoryChangeset>({
    key: changeset => String(changeset.id),
    load: async () => {
      const rows = await FindChangesets.run(shell, { branch, limit: limit + 1 });
      return { hasMore: rows.length > limit, items: rows.slice(0, limit) };
    },
    lookup: text => FindChangesets.runById(shell, Number(text), { ignoreHidden: true }),
    lookupLabel: text => {
      const id = parseObjectNumber(text, "cs");
      return id === undefined ? undefined : { label: `$(search) Look up changeset cs:${id}`, text: String(id) };
    },
    noun: "changeset",
    plural: `changesets on ${branch}`,
    toItem: changesetItem,
  }, { placeHolder: `Type to filter changesets on ${branch}, or a changeset number`, ...options, limit });
}

/** A full branch name the user typed (`/main/x` or `br:/main/x`), or undefined. */
export function parseBranchName(text: string): string | undefined {
  const name = text.trim().replace(/^br:/, "");
  return name.startsWith("/") && name.length > 1 && isQueryable(name) ? name : undefined;
}

/** A label name the user typed (an optional `lb:` is dropped), or undefined. */
export function parseLabelName(text: string): string | undefined {
  const name = text.trim().replace(/^lb:/, "");
  return name.length > 0 && isQueryable(name) ? name : undefined;
}

/** `N` or `<prefix>:N` as a number, or undefined. */
export function parseObjectNumber(text: string, prefix: string): number | undefined {
  const match = new RegExp(`^(?:${prefix}:)?(\\d{1,9})$`).exec(text.trim());
  return match ? Number(match[1]) : undefined;
}

export function branchItem(branch: IBranchInfo, config?: IWorkspaceConfig): QuickPickItem {
  const current = isCurrentBranch(branch, config);
  return {
    description: [ current ? "current" : "", ownerAndDate(branch.owner, branch.date) ]
      .filter(part => part.length > 0).join(" · "),
    detail: firstLine(branch.comment) || undefined,
    label: `$(${current ? "check" : "git-branch"}) ${branch.name}`,
  };
}

export function labelItem(label: ILabelInfo, config?: IWorkspaceConfig): QuickPickItem {
  const current = isCurrentLabel(label, config);
  return {
    description: [
      current ? "current" : "",
      `cs:${label.changesetId}`,
      label.branch,
      ownerAndDate(label.owner, label.date),
    ].filter(part => part.length > 0).join(" · "),
    detail: firstLine(label.comment) || undefined,
    label: `$(${current ? "check" : "tag"}) ${label.name}`,
  };
}

export function shelveItem(shelve: IShelveInfo, config?: IWorkspaceConfig): QuickPickItem {
  const current = isCurrentShelve(shelve, config);
  return {
    description: [ current ? "current" : "", firstLine(shelve.comment) ]
      .filter(part => part.length > 0).join(" · "),
    detail: ownerAndDate(shelve.owner, shelve.date) || undefined,
    label: `$(${current ? "check" : "archive"}) ${shelveSpec(shelve)}`,
  };
}

export function changesetItem(changeset: IHistoryChangeset): QuickPickItem {
  return {
    description: ownerAndDate(changeset.owner, changeset.date),
    detail: firstLine(changeset.comment) || undefined,
    label: `$(git-commit) cs:${changeset.id}`,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** cm queries cannot carry quotes, and the shell cannot carry line breaks. */
function isQueryable(value: string): boolean {
  return !/[\r\n'"\0]/.test(value);
}

interface IPickerSpec<T> {
  noun: string;
  plural: string;
  /** What a lookup row's `text` would be for this value, so a listed value gets no lookup row. */
  key(value: T): string;
  load(): Promise<IListPage<T>>;
  toItem(value: T): QuickPickItem;
  /** The lookup row for typed text that can name an object, or undefined. */
  lookupLabel(text: string): { label: string; text: string } | undefined;
  lookup(text: string): Promise<T | undefined>;
}

interface IPickItem<T> extends QuickPickItem {
  value?: T;
  /** Set on the lookup row: the normalized text to look up. */
  lookup?: string;
  /** Set on value rows: {@link IPickerSpec.key} of the value. */
  lookupKey?: string;
}

/**
 * Shows at once with a busy indicator, fills in when the page loads, offers a
 * lookup row for typed text, and keeps informational rows unselectable.
 */
function showPicker<T>(spec: IPickerSpec<T>, options: IPickerOptions & { limit: number }): Promise<T | undefined> {
  const picker = window.createQuickPick<IPickItem<T>>();
  picker.title = options.title;
  picker.placeholder = options.placeHolder;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.busy = true;
  picker.items = [{ alwaysShow: true, label: `$(loading~spin) Loading ${spec.plural}…` }];

  return new Promise<T | undefined>((resolve, reject) => {
    let loaded: Array<IPickItem<T>> = [];
    let notFound: string | undefined;
    let settled = false;

    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      subscriptions.forEach(subscription => {
        subscription.dispose();
      });
      picker.dispose();
      settle();
    };

    const render = () => {
      const lookup = spec.lookupLabel(picker.value);
      const alreadyListed = lookup && loaded.some(item => item.lookupKey === lookup.text);
      const rows: Array<IPickItem<T>> = [];
      if (lookup && !alreadyListed) {
        rows.push({
          alwaysShow: true,
          description: notFound === lookup.text ? `No ${spec.noun} found` : undefined,
          label: lookup.label,
          lookup: lookup.text,
        });
      }
      picker.items = rows.concat(loaded);
    };

    const subscriptions = [
      picker.onDidChangeValue(() => {
        notFound = undefined;
        if (!picker.busy) {
          render();
        }
      }),
      picker.onDidHide(() => finish(() => resolve(undefined))),
      picker.onDidAccept(() => {
        const item = picker.selectedItems[0];
        if (!item) {
          return;
        }
        if (item.value !== undefined) {
          const value = item.value;
          finish(() => resolve(value));
          return;
        }
        if (item.lookup === undefined || picker.busy) {
          return;
        }
        const text = item.lookup;
        picker.busy = true;
        spec.lookup(text).then(value => {
          if (value !== undefined) {
            finish(() => resolve(value));
            return;
          }
          picker.busy = false;
          notFound = text;
          render();
        }, (error: unknown) => finish(() => reject(toError(error))));
      }),
    ];

    picker.show();

    spec.load().then(page => {
      loaded = page.items.map(value => ({ ...spec.toItem(value), lookupKey: spec.key(value), value }));
      if (loaded.length === 0) {
        loaded = [{ alwaysShow: true, label: `No ${spec.plural} found` }];
      } else if (page.hasMore) {
        loaded.push(
          { kind: QuickPickItemKind.Separator, label: "" },
          {
            alwaysShow: true,
            label: `Showing the newest ${options.limit} ${spec.plural}; type a name or number to find others.`,
          });
      }
      picker.busy = false;
      render();
    }, (error: unknown) => finish(() => reject(toError(error))));
  });
}
