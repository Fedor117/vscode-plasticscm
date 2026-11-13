import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { addRulesToFile, ruleChoices } from "../../commands/ignoreRules";
import { appendRules, buildRule, hasRule, RULE_LISTS, workspaceRelativeRule } from "../../ignoreRules/rules";
import { expect } from "chai";

const ROOT = path.join(path.sep, "work", "Nimbus");
const file = (...parts: string[]) => path.join(ROOT, ...parts);

describe("Rule building", () => {
  it("writes a path rule relative to the workspace root, with forward slashes", () => {
    expect(workspaceRelativeRule(ROOT, file("Assets", "Art", "hero.psd"))).to.equal("/Assets/Art/hero.psd");
    expect(workspaceRelativeRule(ROOT, ROOT)).to.equal(undefined);
    expect(workspaceRelativeRule(ROOT, path.join(path.sep, "elsewhere", "a.txt"))).to.equal(undefined);
  });

  it("offers this item, the name, the extension and the parent folder", () => {
    const target = file("Assets", "Art", "hero.psd");
    expect(buildRule("item", ROOT, target)).to.equal("/Assets/Art/hero.psd");
    expect(buildRule("name", ROOT, target)).to.equal("hero.psd");
    expect(buildRule("extension", ROOT, target)).to.equal("*.psd");
    expect(buildRule("parent", ROOT, target)).to.equal("/Assets/Art");
  });

  it("offers no extension for a name without one and no parent at the root", () => {
    expect(buildRule("extension", ROOT, file("Makefile"))).to.equal(undefined);
    expect(buildRule("extension", ROOT, file("Assets", ".hidden"))).to.equal(undefined);
    expect(buildRule("parent", ROOT, file("ignore.conf"))).to.equal(undefined);
    expect(buildRule("name", ROOT, file("Makefile"))).to.equal("Makefile");
  });

  it("builds the picker choices from every selected file, once per distinct rule", () => {
    const choices = ruleChoices(ROOT, [ file("Assets", "a.psd"), file("Assets", "b.psd"), file("c.txt") ]);
    const byLabel = Object.fromEntries(choices.map(choice => [ choice.label, choice.rules ]));
    expect(byLabel["This item"]).to.eql([ "/Assets/a.psd", "/Assets/b.psd", "/c.txt" ]);
    expect(byLabel["By extension"]).to.eql([ "*.psd", "*.txt" ]);
    expect(byLabel["The parent folder"]).to.eql(["/Assets"]);
    expect(choices.find(choice => choice.label === "By name")?.description).to.equal("3 rules");
  });

  it("describes the three lists", () => {
    expect(RULE_LISTS.ignore.fileName).to.equal("ignore.conf");
    expect(RULE_LISTS.hiddenChanges.fileName).to.equal("hidden_changes.conf");
    expect(RULE_LISTS.cloaked.fileName).to.equal("cloaked.conf");
  });
});

describe("Appending rules", () => {
  it("appends a rule on its own line, after a final newline or without one", () => {
    expect(appendRules("bin\n", ["*.obj"])).to.eql({ added: ["*.obj"], content: "bin\n*.obj\n" });
    expect(appendRules("bin", ["*.obj"]).content).to.equal("bin\n*.obj\n");
    expect(appendRules("", ["/Library"]).content).to.equal("/Library\n");
  });

  it("keeps CRLF line endings", () => {
    expect(appendRules("bin\r\nobj\r\n", ["*.obj"]).content).to.equal("bin\r\nobj\r\n*.obj\r\n");
  });

  it("never writes a rule twice, ignoring case and blanks, and leaves the content alone", () => {
    expect(hasRule("bin\n  *.OBJ  \n", "*.obj")).to.equal(true);
    expect(appendRules("bin\n*.obj\n", ["*.obj"])).to.eql({ added: [], content: "bin\n*.obj\n" });
    expect(appendRules("", [ "a", "a", "b" ]).added).to.eql([ "a", "b" ]);
  });

  it("refuses a rule that would break the file", () => {
    expect(appendRules("a\n", [ "x\ny", "" ]).added).to.eql([]);
  });
});

describe("Writing the rule files", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plastic-rules-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it("creates a missing file", async () => {
    const added = await addRulesToFile(dir, RULE_LISTS.ignore, ["*.tmp"]);
    expect(added).to.eql(["*.tmp"]);
    expect(fs.readFileSync(path.join(dir, "ignore.conf"), "utf8")).to.equal("*.tmp\n");
  });

  it("appends to an existing file and does not duplicate", async () => {
    fs.writeFileSync(path.join(dir, "cloaked.conf"), "/Library\n");
    expect(await addRulesToFile(dir, RULE_LISTS.cloaked, [ "/Library", "/Temp" ])).to.eql(["/Temp"]);
    expect(await addRulesToFile(dir, RULE_LISTS.cloaked, ["/Temp"])).to.eql([]);
    expect(fs.readFileSync(path.join(dir, "cloaked.conf"), "utf8")).to.equal("/Library\n/Temp\n");
  });

  it("keeps a byte order mark", async () => {
    fs.writeFileSync(path.join(dir, "hidden_changes.conf"), "﻿a.txt\n");
    await addRulesToFile(dir, RULE_LISTS.hiddenChanges, ["b.txt"]);
    expect(fs.readFileSync(path.join(dir, "hidden_changes.conf"), "utf8")).to.equal("﻿a.txt\nb.txt\n");
  });
});
