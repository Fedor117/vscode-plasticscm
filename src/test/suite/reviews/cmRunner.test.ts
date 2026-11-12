import { CancellationTokenSource } from "vscode";
import { expect } from "chai";
import { spawnCm } from "../../../reviews/cmRunner";

/**
 * The one-shot runner on a real child process: Node itself stands in for cm,
 * so nothing here runs cm or reaches a server.
 */
describe("spawnCm (Node as the child process)", () => {
  const node = process.execPath;
  // Electron's binary runs as Node when told to; a plain Node ignores the variable.
  const asNode = (): void => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
  };
  let before: string | undefined;

  beforeEach(() => {
    before = process.env.ELECTRON_RUN_AS_NODE;
    asNode();
  });
  afterEach(() => {
    if (before === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = before;
    }
  });

  it("passes arguments as they are, runs in the folder, and writes the text to stdin", async () => {
    const script = "let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => text += c);" +
      "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ args: process.argv.slice(1), " +
      "cwd: process.cwd(), text })); process.stderr.write('warned'); process.exit(3); });";
    const args = [ "-e", script, "--", "a b", "$(c)", "\"d\"", "--line=5" ];
    const text = "First\n  \"second\" & $(third) ünïcödé\n";
    const output = await spawnCm(node, { args, cwd: __dirname, stdin: text });
    expect(output.code).to.equal(3);
    expect(output.started).to.equal(true);
    expect(output.stderr).to.equal("warned");
    const seen = JSON.parse(output.stdout) as { args: string[]; cwd: string; text: string };
    expect(seen.args).to.deep.equal([ "a b", "$(c)", "\"d\"", "--line=5" ]);
    expect(seen.text).to.equal(text);
    expect(seen.cwd.toLowerCase()).to.contain(__dirname.split(/[\\/]/).pop()!.toLowerCase());
  });

  it("closes stdin when there is nothing to write", async () => {
    const script = "process.stdin.on('data', () => {}); process.stdin.on('end', () => process.stdout.write('ended'));";
    const output = await spawnCm(node, { args: [ "-e", script ] });
    expect([ output.code, output.stdout ]).to.deep.equal([ 0, "ended" ]);
  });

  it("says a missing executable is missing, and that it never started", async () => {
    const output = await spawnCm("/nowhere/no-such-cm-executable", { args: ["version"] });
    expect(output).to.include({ code: undefined, missing: true, started: false });
    expect(output.cwdMissing).to.not.equal(true);
  });

  it("tells a missing folder from a missing executable, which the operating system reports alike", async () => {
    const output = await spawnCm(node, { args: [ "-e", "1" ], cwd: "/nowhere/no-such-workspace-folder" });
    expect(output).to.include({ code: undefined, cwdMissing: true, missing: false, started: false });
  });

  it("kills at the timeout and says so", async () => {
    const output = await spawnCm(node, { args: [ "-e", "setTimeout(() => {}, 60000);" ], timeout: 200 });
    expect(output).to.include({ code: undefined, killed: "timeout", started: true });
  });

  it("kills when cancelled, and does not start once cancelled", async () => {
    const source = new CancellationTokenSource();
    const running = spawnCm(node, { args: [ "-e", "setTimeout(() => {}, 60000);" ], cancel: source.token });
    setTimeout(() => source.cancel(), 100);
    expect(await running).to.include({ code: undefined, killed: "cancelled", started: true });
    const output = await spawnCm(node, { args: [ "-e", "process.stdout.write('ran')" ], cancel: source.token });
    expect(output).to.include({ code: undefined, killed: "cancelled", started: false, stdout: "" });
    source.dispose();
  });
});
