import { appendRules, buildRule, IRuleList, RULE_LISTS, RuleKind } from "../ignoreRules/rules";
import { commands, Disposable, QuickPickItem, Uri, window } from "vscode";
import { fileTargetUris, groupUrisByWorkspace } from "./fileTargets";
import { promises as fs } from "fs";
import { join } from "path";
import { PlasticScm } from "../plasticScm";
import { showOperationError } from "./scmUtils";
import { Workspace } from "../workspace";

export const IGNORE_RULE_COMMANDS = {
  addCloaked: "plastic-scm.cloaked.add",
  addHiddenChanges: "plastic-scm.hiddenChanges.add",
  addIgnore: "plastic-scm.ignore.add",
  openCloaked: "plastic-scm.cloaked.open",
  openHiddenChanges: "plastic-scm.hiddenChanges.open",
  openIgnore: "plastic-scm.ignore.open",
};

const KIND_LABELS: ReadonlyArray<{ kind: RuleKind; label: string }> = [
  { kind: "item", label: "This item" },
  { kind: "name", label: "By name" },
  { kind: "extension", label: "By extension" },
  { kind: "parent", label: "The parent folder" },
];

interface IKindItem extends QuickPickItem {
  readonly rules: string[];
}

/** The choices that apply to at least one of the files, each with the rules it would write. */
export function ruleChoices(workspacePath: string, fsPaths: readonly string[]): IKindItem[] {
  const items: IKindItem[] = [];
  for (const { kind, label } of KIND_LABELS) {
    const built = fsPaths.map(fsPath => buildRule(kind, workspacePath, fsPath));
    const rules = Array.from(new Set(built.filter((rule): rule is string => rule !== undefined)));
    if (rules.length > 0) {
      const many = rules.length > 1;
      items.push({
        description: many ? `${rules.length} rules` : rules[0],
        detail: many ? rules.slice(0, 3).join(", ") + (rules.length > 3 ? ", ..." : "") : undefined,
        label,
        rules,
      });
    }
  }
  return items;
}

/**
 * Appends rules to `<workspace root>/<file>` (creating it when missing).
 * Returns the rules that were new. The file is versioned like any other, so the
 * change shows up in pending changes.
 */
export async function addRulesToFile(
    workspaceRoot: string, list: IRuleList, rules: readonly string[]): Promise<string[]> {
  const target = join(workspaceRoot, list.fileName);

  let content = "";
  try {
    content = await fs.readFile(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }

  const bom = content.startsWith("﻿") ? "﻿" : "";
  const result = appendRules(content.substring(bom.length), rules);
  if (result.added.length > 0) {
    await fs.writeFile(target, bom + result.content, "utf8");
  }
  return result.added;
}

/**
 * "Add to Ignore List", "Add to Hidden Changes List", "Add to Cloaked List" and
 * the commands that open the three files.
 */
export class IgnoreRuleCommands implements Disposable {
  private readonly mDisposables: Disposable[];

  public constructor(private readonly mPlasticScm: PlasticScm) {
    this.mDisposables = [
      commands.registerCommand(
        IGNORE_RULE_COMMANDS.addIgnore, (...args: unknown[]) => this.add(RULE_LISTS.ignore, args)),
      commands.registerCommand(
        IGNORE_RULE_COMMANDS.addHiddenChanges, (...args: unknown[]) => this.add(RULE_LISTS.hiddenChanges, args)),
      commands.registerCommand(
        IGNORE_RULE_COMMANDS.addCloaked, (...args: unknown[]) => this.add(RULE_LISTS.cloaked, args)),
      commands.registerCommand(IGNORE_RULE_COMMANDS.openIgnore, () => this.open(RULE_LISTS.ignore)),
      commands.registerCommand(IGNORE_RULE_COMMANDS.openHiddenChanges, () => this.open(RULE_LISTS.hiddenChanges)),
      commands.registerCommand(IGNORE_RULE_COMMANDS.openCloaked, () => this.open(RULE_LISTS.cloaked)),
    ];
  }

  public dispose(): void {
    this.mDisposables.forEach(disposable => {
      disposable.dispose();
    });
  }

  private async add(list: IRuleList, args: unknown[]): Promise<void> {
    const uris = fileTargetUris(args, window.activeTextEditor?.document.uri);
    for (const [ workspace, owned ] of groupUrisByWorkspace(this.mPlasticScm, uris)) {
      await this.addForWorkspace(workspace, list, owned);
    }
  }

  private async addForWorkspace(workspace: Workspace, list: IRuleList, owned: Uri[]): Promise<void> {
    const choices = ruleChoices(workspace.info.path, owned.map(uri => uri.fsPath));
    if (choices.length === 0) {
      void window.showInformationMessage("There is no rule to add for that selection.");
      return;
    }

    const choice = await window.showQuickPick(choices, {
      ignoreFocusOut: true,
      placeHolder: `${list.addTitle}: which rule goes into ${list.fileName}? ${list.summary}`,
      title: list.addTitle,
    });
    if (!choice) {
      return;
    }

    try {
      const added = await addRulesToFile(workspace.info.path, list, choice.rules);
      if (added.length === 0) {
        const those = choice.rules.length === 1 ? "that rule" : "those rules";
        void window.showInformationMessage(`${list.fileName} already has ${those}.`);
        return;
      }
      const what = added.length === 1 ? added[0] : `${added.length} rules`;
      window.setStatusBarMessage(`Added ${what} to ${list.fileName}`, 5000);
      await workspace.updateWorkspaceStatus();
    } catch (e) {
      await showOperationError(this.mPlasticScm, list.addTitle, e);
    }
  }

  private async open(list: IRuleList): Promise<void> {
    const workspace = await this.mPlasticScm.promptUserToPickWorkspace(`Which workspace's ${list.fileName}?`);
    if (!workspace) {
      return;
    }

    const target = join(workspace.info.path, list.fileName);
    try {
      await fs.access(target);
    } catch {
      const create = "Create";
      const answer = await window.showInformationMessage(
        `${list.fileName} does not exist in '${workspace.info.name}'. Create it?`, create);
      if (answer !== create) {
        return;
      }
      try {
        await fs.writeFile(target, "", { encoding: "utf8", flag: "wx" });
      } catch (e) {
        await showOperationError(this.mPlasticScm, `Open ${list.fileName}`, e);
        return;
      }
    }

    await commands.executeCommand("vscode.open", Uri.file(target));
  }
}
