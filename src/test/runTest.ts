import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { runTests } from "@vscode/test-electron";

/**
 * Well-known locations of a normal VS Code install, in the order we prefer them.
 * Reusing one skips a ~200MB download per checkout and keeps the suite runnable
 * offline; tests still get their own --user-data-dir and --extensions-dir, so the
 * real profile is never touched.
 */
function getCandidateExecutables(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

  if (process.platform === "darwin") {
    const app = "Visual Studio Code.app/Contents/MacOS/Code";
    return [
      path.join("/Applications", app),
      path.join(home, "Applications", app),
    ];
  }

  if (process.platform === "win32") {
    return [
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
      path.join(process.env.ProgramFiles ?? "", "Microsoft VS Code", "Code.exe"),
    ];
  }

  return [ "/usr/share/code/code", "/opt/visual-studio-code/code", "/usr/bin/code" ];
}

/**
 * Returns the executable to test against, or undefined to let test-electron
 * download one. VSCODE_TEST_EXECUTABLE wins so CI can pin a specific build.
 */
function findVsCodeExecutable(): string | undefined {
  const fromEnv = process.env.VSCODE_TEST_EXECUTABLE;
  if (fromEnv) {
    return fromEnv;
  }

  return getCandidateExecutables().find(candidate => fs.existsSync(candidate));
}

function main() {
  // The folder containing the Extension Manifest package.json
  // Passed to `--extensionDevelopmentPath`
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");

  // The path to test runner
  // Passed to --extensionTestsPath
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  const vscodeExecutablePath = findVsCodeExecutable();

  // VS Code opens a unix domain socket under the user data dir, and those cap out
  // at 103 characters. Keeping it in the temp dir means the suite still runs from
  // a deeply nested checkout, such as a worktree.
  const launchArgs = [ "--user-data-dir", path.join(os.tmpdir(), "vscode-plasticscm-test") ];

  // eslint-disable-next-line no-console
  console.log(vscodeExecutablePath
    ? `Testing against installed VS Code: ${vscodeExecutablePath}`
    : "No local VS Code found, downloading one.");

  runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs, vscodeExecutablePath }).then(null, err => {
    // eslint-disable-next-line no-console
    console.error("Failed to run tests", err);
    process.exit(1);
  });
}

main();
