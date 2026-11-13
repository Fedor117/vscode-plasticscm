import { assertCmArgument } from "../refNames";
import { assertInteger } from "../findChangesets/findChangesets";
import { ICmShell } from "../../shell";
import { runMutation } from "../runMutation";

/**
 * `cm revert <path>#cs:<N>`: loads the content the file had in changeset N into
 * the workspace. The item must be checked in; what cm prints is not observed
 * (it changes the workspace), so success is cm's exit code.
 */
export class RevertItem {
  public static run(shell: ICmShell, path: string, changesetId: number): Promise<string[]> {
    assertCmArgument(path, "path");
    if (path.includes("#")) {
      return Promise.reject(new Error(`The path '${path}' contains '#', which cm reads as a revision spec.`));
    }
    assertInteger(changesetId, "changesetId");

    return runMutation(shell, { args: [`${path}#cs:${changesetId}`], command: "revert", name: "revert" });
  }
}
