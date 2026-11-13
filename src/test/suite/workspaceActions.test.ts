import { describeTarget, planUpdate } from "../../commands/workspaceActions";
import { expect } from "chai";
import { hasIncomingChanges } from "../../incomingChanges";
import { WkConfigType } from "../../models";

const branchConfig = {
  configType: WkConfigType.Branch,
  location: "/main/task001",
  repSpec: "Nimbus@acme-studio@unity",
};

describe("describeTarget", () => {
  it("names each kind of target", () => {
    expect(describeTarget({ kind: "branch", name: "/main" })).to.equal("branch /main");
    expect(describeTarget({ id: 42, kind: "changeset" })).to.equal("changeset cs:42");
    expect(describeTarget({ kind: "label", name: "v1" })).to.equal("label v1");
  });
});

describe("planUpdate", () => {
  it("updates a workspace on a branch as it is", () => {
    expect(planUpdate(branchConfig)).to.eql({ kind: "update" });
    expect(planUpdate(undefined)).to.eql({ kind: "update" });
  });

  it("moves a workspace on a changeset or label to its branch with --last", () => {
    expect(planUpdate({ ...branchConfig, configType: WkConfigType.Changeset, location: "42" }))
      .to.eql({ from: "changeset cs:42", kind: "update-last" });
    expect(planUpdate({ ...branchConfig, configType: WkConfigType.Changeset, location: "cs:42" }))
      .to.eql({ from: "changeset cs:42", kind: "update-last" });
    expect(planUpdate({ ...branchConfig, configType: WkConfigType.Label, location: "v1" }))
      .to.eql({ from: "label v1", kind: "update-last" });
  });

  it("does not update a workspace on a shelve", () => {
    expect(planUpdate({ ...branchConfig, configType: WkConfigType.Shelve, location: "3" }).kind)
      .to.equal("unsupported");
  });
});

describe("hasIncomingChanges", () => {
  const head = { branch: "/main/task001", changesetId: 50 };

  it("is true when the branch head is newer than the workspace's changeset", () => {
    expect(hasIncomingChanges(branchConfig, 49, head)).to.equal(true);
  });

  it("is false when the workspace is at the head", () => {
    expect(hasIncomingChanges(branchConfig, 50, head)).to.equal(false);
  });

  it("is false for a head of another branch, for example right after a switch", () => {
    expect(hasIncomingChanges(branchConfig, 1, { branch: "/main", changesetId: 50 })).to.equal(false);
  });

  it("is false when something is not known yet", () => {
    expect(hasIncomingChanges(undefined, 1, head)).to.equal(false);
    expect(hasIncomingChanges(branchConfig, undefined, head)).to.equal(false);
    expect(hasIncomingChanges(branchConfig, 1, undefined)).to.equal(false);
  });

  it("is false for a workspace on a changeset or a label, which stays where it is", () => {
    expect(hasIncomingChanges({ ...branchConfig, configType: WkConfigType.Changeset }, 1, head)).to.equal(false);
    expect(hasIncomingChanges({ ...branchConfig, configType: WkConfigType.Label }, 1, head)).to.equal(false);
  });
});
