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

  context("command", () => {
    function resourceWith(
        type: ChangeType, revisionType: RevisionType, oldPath?: Uri, changeset = 42): PlasticScmResource {
      const workspace = Mock.ofType<Workspace>();
      workspace.setup(w => w.currentChangeset).returns(() => changeset);
      workspace.setup(w => w.info).returns(() => ({ id: "wk1", name: "Nimbus", path: "/wk" }));
      return new PlasticScmResource(
        { oldPath, path: Uri.file("/wk/foo.cs"), revisionType, type }, workspace.object);
    }

    it("diffs a changed text file against the loaded changeset", () => {
      const command = resourceWith(ChangeType.Changed, RevisionType.TextFile).command!;
      expect(command.command).to.equal("vscode.diff");
      expect((command.arguments![0] as Uri).scheme).to.equal("plastic");
      expect((command.arguments![1] as Uri).fsPath).to.equal(Uri.file("/wk/foo.cs").fsPath);
    });

    it("opens an added file itself, binary or not", () => {
      for (const revisionType of [ RevisionType.TextFile, RevisionType.BinaryFile ]) {
        const command = resourceWith(ChangeType.Added, revisionType).command!;
        expect(command.command).to.equal("vscode.open");
        expect((command.arguments![0] as Uri).fsPath).to.equal(Uri.file("/wk/foo.cs").fsPath);
      }
      expect(resourceWith(ChangeType.Added, RevisionType.Directory).command).to.equal(undefined);
    });

    it("opens the base revision of a deleted text file from the read-only plastic: scheme", () => {
      const command = resourceWith(ChangeType.Deleted, RevisionType.TextFile).command!;
      expect(command.command).to.equal("vscode.open");
      const base = command.arguments![0] as Uri;
      expect(base.scheme).to.equal("plastic");
      expect(base.fsPath).to.equal(Uri.file("/wk/foo.cs").fsPath);
      expect(JSON.parse(base.query)).to.eql({ changeset: 42, wkId: "wk1" });
      expect(resourceWith(ChangeType.Deleted, RevisionType.BinaryFile).command).to.equal(undefined);
    });

    it("diffs a moved file: the old path at the loaded changeset against the new path", () => {
      const oldPath = Uri.file("/wk/old/foo.cs");
      const command = resourceWith(ChangeType.Moved, RevisionType.TextFile, oldPath).command!;
      expect(command.command).to.equal("vscode.diff");
      const [ left, right, title ] = command.arguments as [ Uri, Uri, string ];
      expect(left.scheme).to.equal("plastic");
      expect(left.fsPath).to.equal(oldPath.fsPath);
      expect(JSON.parse(left.query).changeset).to.equal(42);
      expect(right.fsPath).to.equal(Uri.file("/wk/foo.cs").fsPath);
      expect(title).to.equal("foo.cs ↔ foo.cs (Moved)");
    });

    it("opens nothing for a moved file of unknown origin, private files, or before a changeset is loaded", () => {
      expect(resourceWith(ChangeType.Moved, RevisionType.TextFile).command).to.equal(undefined);
      expect(resourceWith(ChangeType.Private, RevisionType.TextFile).command).to.equal(undefined);
      expect(resourceWith(ChangeType.Changed, RevisionType.TextFile, undefined, -1).command).to.equal(undefined);
    });
  });
});
