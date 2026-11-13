import { extname, relative, sep } from "path";

/** The three rule files at the workspace root; all read the same line format. */
export interface IRuleList {
  /** Command-id fragment and key. */
  readonly id: "ignore" | "hiddenChanges" | "cloaked";
  readonly fileName: string;
  /** Command title, e.g. "Add to Ignore List". */
  readonly addTitle: string;
  /** What the list does, for the picker. */
  readonly summary: string;
}

export const RULE_LISTS: { readonly [id in IRuleList["id"]]: IRuleList } = {
  cloaked: {
    addTitle: "Add to Cloaked List",
    fileName: "cloaked.conf",
    id: "cloaked",
    summary: "Cloaked items are left out of what update and switch download into the workspace.",
  },
  hiddenChanges: {
    addTitle: "Add to Hidden Changes List",
    fileName: "hidden_changes.conf",
    id: "hiddenChanges",
    summary: "Changes to hidden items are not listed in pending changes.",
  },
  ignore: {
    addTitle: "Add to Ignore List",
    fileName: "ignore.conf",
    id: "ignore",
    summary: "Ignored private items are not listed in pending changes and are not added.",
  },
};

/** The choices the Plastic SCM desktop app offers for an item. */
export type RuleKind = "item" | "name" | "extension" | "parent";

/** A path under the workspace root as the rule files write it: `/` first, `/` inside, whatever the platform. */
export function workspaceRelativeRule(workspacePath: string, fsPath: string): string | undefined {
  const rel = relative(workspacePath, fsPath);
  if (rel.length === 0 || rel.startsWith("..")) {
    return undefined;
  }
  return "/" + rel.split(sep).join("/").replace(/\\/g, "/");
}

/**
 * The rule line a choice stands for, or undefined when the choice does not
 * apply to the item (no extension, already at the root, outside the workspace).
 *   item      `/Assets/Art/hero.psd`  this exact item
 *   name      `hero.psd`              any item with this name
 *   extension `*.psd`                 any item with this extension
 *   parent    `/Assets/Art`           the folder the item is in
 */
export function buildRule(kind: RuleKind, workspacePath: string, fsPath: string): string | undefined {
  const path = workspaceRelativeRule(workspacePath, fsPath);
  if (path === undefined) {
    return undefined;
  }

  switch (kind) {
  case "item":
    return path;
  case "name":
    return path.substring(path.lastIndexOf("/") + 1);
  case "extension": {
    const extension = extname(path);
    return extension.length > 1 ? `*${extension}` : undefined;
  }
  case "parent": {
    const parent = path.substring(0, path.lastIndexOf("/"));
    return parent.length > 0 ? parent : undefined;
  }
  }
}

/** Rules containing a line break or a quote-less control character would corrupt the file. */
export function isWritableRule(rule: string): boolean {
  return rule.trim().length > 0 && !/[\r\n\0]/.test(rule);
}

/** True when `content` already has `rule` as a line. Compared ignoring case and surrounding blanks. */
export function hasRule(content: string, rule: string): boolean {
  const wanted = rule.trim().toLowerCase();
  return content.split(/\r?\n/).some(line => line.trim().toLowerCase() === wanted);
}

/**
 * `content` with `rules` appended, each on a line of its own, keeping the
 * file's line endings and never writing a rule twice. Returns the new content
 * and the rules that were really added; the content is unchanged (and `added`
 * empty) when every rule was already there.
 */
export function appendRules(content: string, rules: readonly string[]): { content: string; added: string[] } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const added: string[] = [];
  let result = content;

  for (const rule of rules) {
    if (!isWritableRule(rule) || hasRule(result, rule) || added.includes(rule)) {
      continue;
    }
    if (result.length > 0 && !result.endsWith("\n")) {
      result += eol;
    }
    result += rule.trim() + eol;
    added.push(rule);
  }

  return { added, content: result };
}
