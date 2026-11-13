import { branchItem, changesetItem, labelItem, parseBranchName, parseLabelName, parseObjectNumber, shelveItem }
  from "../../../repository/pickers";
import { IBranchInfo, IWorkspaceConfig, WkConfigType } from "../../../models";
import { expect } from "chai";

const MAIN: IBranchInfo = {
  comment: "\n  Trunk\nmore",
  date: new Date(0),
  guid: "",
  headChangesetId: 1,
  name: "/main",
  owner: "someone@example.com",
  repository: "Nimbus/Nimbus",
  server: "acme-studio@unity",
};

function config(configType: WkConfigType, location: string): IWorkspaceConfig {
  return { configType, location, repSpec: "Nimbus/Nimbus@acme-studio@unity" };
}

describe("Repository pickers", () => {
  context("Typed values", () => {
    it("reads full branch names, with or without br:", () => {
      expect(parseBranchName(" /main/task001 ")).to.equal("/main/task001");
      expect(parseBranchName("br:/main")).to.equal("/main");
    });

    it("rejects short names, bare slashes and quotes", () => {
      [ "task001", "/", "", "/main/it's", "/main/\"x\"", "/main/a\nb" ].forEach(text => {
        expect(parseBranchName(text), JSON.stringify(text)).to.be.undefined;
      });
    });

    it("reads label names, dropping lb:", () => {
      expect(parseLabelName("lb:Release 1.0 (iOS)")).to.equal("Release 1.0 (iOS)");
      expect(parseLabelName("  ")).to.be.undefined;
      expect(parseLabelName("it's")).to.be.undefined;
    });

    it("reads numbers with or without the prefix", () => {
      expect(parseObjectNumber("cs:42", "cs")).to.equal(42);
      expect(parseObjectNumber(" 42 ", "cs")).to.equal(42);
      expect(parseObjectNumber("sh:42", "cs")).to.be.undefined;
      expect(parseObjectNumber("4.2", "sh")).to.be.undefined;
      expect(parseObjectNumber("-1", "sh")).to.be.undefined;
      expect(parseObjectNumber("1234567890", "cs")).to.be.undefined;
    });
  });

  context("Rows", () => {
    it("marks the current branch and shows the comment's first line", () => {
      const item = branchItem(MAIN, config(WkConfigType.Branch, "/main"));
      expect(item.label).to.equal("$(check) /main");
      expect(item.description).to.equal("current · someone@example.com");
      expect(item.detail).to.equal("Trunk");
    });

    it("shows other branches with the branch icon", () => {
      const item = branchItem({ ...MAIN, comment: "" }, config(WkConfigType.Label, "/main"));
      expect(item.label).to.equal("$(git-branch) /main");
      expect(item.detail).to.be.undefined;
    });

    it("describes labels by changeset and branch", () => {
      const item = labelItem({
        branch: "/main", changesetId: 9, comment: "", date: new Date(0), id: 1, name: "v1",
        owner: "someone@example.com", repository: "Nimbus/Nimbus", server: "acme-studio@unity",
      });
      expect(item.label).to.equal("$(tag) v1");
      expect(item.description).to.equal("cs:9 · /main · someone@example.com");
    });

    it("names shelves sh:N", () => {
      const item = shelveItem({
        comment: "WIP", date: new Date(0), guid: "", id: 1, owner: "someone@example.com",
        parentChangesetId: 3, repository: "Nimbus/Nimbus", server: "acme-studio@unity", shelveId: 5,
      }, config(WkConfigType.Shelve, "5"));
      expect(item.label).to.equal("$(check) sh:5");
      expect(item.description).to.equal("current · WIP");
    });

    it("names changesets cs:N", () => {
      const item = changesetItem({
        branch: "/main", comment: "Fix", date: new Date(0), guid: "", id: 77, owner: "someone@example.com",
        parentId: 76, repository: "Nimbus/Nimbus", server: "acme-studio@unity",
      });
      expect(item.label).to.equal("$(git-commit) cs:77");
      expect(item.detail).to.equal("Fix");
    });
  });
});
