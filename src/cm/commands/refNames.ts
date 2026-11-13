/**
 * Validation of names the user types for branches and labels. The shell wraps
 * every argument in double quotes without escaping (CmShell.buildCommandLine),
 * and cm reads `@` in a spec as the start of the repository, so those names
 * are refused before cm is called.
 */

/** The reason `name` cannot be used in a cm spec or argument, or undefined when it can. */
function commonProblem(name: string, noun: string): string | undefined {
  if (name.length === 0) {
    return `Enter a ${noun} name.`;
  }
  if (name !== name.trim()) {
    return `A ${noun} name cannot start or end with a space.`;
  }
  if (/[\r\n\0"]/.test(name)) {
    return `A ${noun} name cannot contain quotes or line breaks.`;
  }
  if (name.includes("@")) {
    return `A ${noun} name cannot contain '@': cm reads it as the start of the repository.`;
  }
  if (name.startsWith("-")) {
    return `A ${noun} name cannot start with '-': cm would read it as an option.`;
  }
  return undefined;
}

/** For one branch name segment, e.g. `task001` (no `/`). Undefined means valid. */
export function branchNameProblem(shortName: string): string | undefined {
  return commonProblem(shortName, "branch") ?? (shortName.includes("/")
    ? "A branch name cannot contain '/': that would make it a child of another branch."
    : undefined);
}

/** For a label name. Undefined means valid. */
export function labelNameProblem(name: string): string | undefined {
  return commonProblem(name, "label");
}

export function assertBranchShortName(shortName: string): void {
  const problem = branchNameProblem(shortName);
  if (problem) {
    throw new Error(problem);
  }
}

export function assertLabelName(name: string): void {
  const problem = labelNameProblem(name);
  if (problem) {
    throw new Error(problem);
  }
}

/** A full branch name such as `/main/task001`: absolute, every segment valid. */
export function assertFullBranchName(fullName: string): void {
  if (!fullName.startsWith("/") || fullName.length < 2) {
    throw new Error(`Branch name '${fullName}' must be a full name such as /main/task001.`);
  }
  for (const segment of fullName.substring(1).split("/")) {
    assertBranchShortName(segment);
  }
}

/** `/main` + `task` is `/main/task`. */
export function childBranchName(parent: string, shortName: string): string {
  return `${parent.replace(/\/+$/, "")}/${shortName}`;
}

/** The last segment of a full branch name: `/main/task` is `task`. */
export function branchShortName(fullName: string): string {
  return fullName.substring(fullName.lastIndexOf("/") + 1);
}

/** The parent of a full branch name: `/main/task` is `/main`; a top-level branch has none. */
export function branchParentName(fullName: string): string | undefined {
  const index = fullName.lastIndexOf("/");
  return index > 0 ? fullName.substring(0, index) : undefined;
}

/** Throws when `value` cannot be passed to cm as one double-quoted argument (a quote, a line break, a NUL). */
export function assertCmArgument(value: string, noun: string): void {
  if (value.length === 0 || /[\r\n\0"]/.test(value)) {
    throw new Error(
      `The ${noun} '${value.replace(/[\r\n]/g, " ")}' cannot be passed to cm: ` +
      "it is empty or contains a quote or a line break.");
  }
}
