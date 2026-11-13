import { assertFullBranchName, assertLabelName } from "../refNames";
import { LONG_COMMAND_TIMEOUT_MILLIS, runMutation } from "../runMutation";
import { assertInteger } from "../findChangesets/findChangesets";
import { ICmShell } from "../../shell";

/** Where `cm switch` can take a workspace. */
export type SwitchTarget =
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "changeset"; readonly id: number }
  | { readonly kind: "label"; readonly name: string };

/** The cm spec of a target: `br:/main/x`, `cs:42` or `lb:v1`. Throws for a name or id cm cannot be given. */
export function switchSpec(target: SwitchTarget): string {
  switch (target.kind) {
  case "branch":
    assertFullBranchName(target.name);
    return `br:${target.name}`;
  case "changeset":
    assertInteger(target.id, "changeset");
    return `cs:${target.id}`;
  case "label":
    assertLabelName(target.name);
    return `lb:${target.name}`;
  }
}

/**
 * `cm switch <spec> --noinput`, in the workspace the shell was started in.
 * `--noinput` is required because the shell cannot answer cm's questions about
 * pending changes; per `cm help switch` it also disables bringing them along.
 * A switch downloads files and can take minutes, so it gets a generous bound instead of the default timeout.
 */
export class SwitchWorkspace {
  public static run(shell: ICmShell, target: SwitchTarget): Promise<string[]> {
    return runMutation(shell, {
      args: [ switchSpec(target), "--noinput" ],
      command: "switch",
      name: "switch",
      options: { timeoutMillis: LONG_COMMAND_TIMEOUT_MILLIS },
    });
  }
}
