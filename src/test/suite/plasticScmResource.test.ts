import { ChangeType, IChangeInfo, RevisionType } from "../../models";
import { IMock, Mock } from "typemoq";
import { expect } from "chai";
import { PlasticScmResource } from "../../plasticScmResource";
import { Uri } from "vscode";
import { Workspace } from "../../workspace";

function buildResource(type: ChangeType, revisionType: RevisionType): PlasticScmResource {
  const workspaceMock: IMock<Workspace> = Mock.ofType<Workspace>();
  const changeInfo: IChangeInfo = {
    path: Uri.file("/wk/foo.cs"),
    revisionType,
    type,
  };

  return new PlasticScmResource(changeInfo, workspaceMock.object);
}

describe("PlasticScmResource", () => {
  context("contextValue", () => {
    it("names a single change type", () => {
      expect(buildResource(ChangeType.Private, RevisionType.TextFile).contextValue)
        .to.equal("private,file,text");
    });

    it("lists every flag of a compound change, so `=~` matches any of them", () => {
      const contextValue = buildResource(
        ChangeType.Checkedout | ChangeType.Changed, RevisionType.TextFile).contextValue;

      expect(contextValue).to.equal("changed,checkedout,file,text");
      expect(/checkedout/.exec(contextValue)).to.be.not.null;
      expect(/changed/.exec(contextValue)).to.be.not.null;
    });

    it("distinguishes binaries and directories", () => {
      expect(buildResource(ChangeType.Added, RevisionType.BinaryFile).contextValue)
        .to.equal("added,file,binary");
      expect(buildResource(ChangeType.Added, RevisionType.Directory).contextValue)
        .to.equal("added,directory");
    });

    it("marks a revision of unknown type as a file, since only directories are excluded", () => {
      expect(buildResource(ChangeType.Deleted, RevisionType.Unknown).contextValue)
        .to.equal("deleted,file");
    });

    it("gives every non-directory the `file` token menus match on", () => {
      const revisionTypes = [
        RevisionType.TextFile, RevisionType.BinaryFile, RevisionType.Unknown ];

      for (const revisionType of revisionTypes) {
        expect(/file/.exec(buildResource(ChangeType.Changed, revisionType).contextValue))
          .to.be.not.null;
      }

      expect(/file/.exec(buildResource(ChangeType.Changed, RevisionType.Directory).contextValue))
        .to.be.null;
    });

    it("never yields an empty string", () => {
      expect(buildResource(ChangeType.Controlled, RevisionType.Unknown).contextValue)
        .to.equal("file");
    });
  });

  context("isDirectory", () => {
    it("is set only for directories", () => {
      expect(buildResource(ChangeType.Changed, RevisionType.Directory).isDirectory).to.be.true;
      expect(buildResource(ChangeType.Changed, RevisionType.TextFile).isDirectory).to.be.false;
      expect(buildResource(ChangeType.Changed, RevisionType.Unknown).isDirectory).to.be.false;
    });
  });

  context("letter", () => {
    it("badges a compound change in display precedence", () => {
      expect(buildResource(
        ChangeType.Checkedout | ChangeType.Changed, RevisionType.TextFile).letter)
        .to.equal("CCO");
    });

    it("badges a private file", () => {
      expect(buildResource(ChangeType.Private, RevisionType.TextFile).letter).to.equal("P");
    });
  });
});
