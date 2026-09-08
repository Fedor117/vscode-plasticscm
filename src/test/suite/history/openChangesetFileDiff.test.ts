import { FileChangeStatus, IChangesetFileChange, IHistoryChangeset, RevisionType } from "../../../models";
import { parseRevisionQuery, revisionScheme } from "../../../revisionContentProvider";
import { describeChangesetFileDiff } from "../../../history/openChangesetFileDiff";
import { expect } from "chai";
import { Uri } from "vscode";

const WORKSPACE_ID = "wk-1";
const REPOSITORY = "Nimbus/Nimbus@acme-studio@unity";

const changeset: IHistoryChangeset = {
  branch: "/main/release_3",
  comment: "Rename the lap time banner",
  date: new Date("2026-09-07T16:56:14+01:00"),
  guid: "cafe0001-4b1d-4c2e-9d3f-5a6b7c8d9e0f",
  id: 3624,
  owner: "dana.kim@example.com",
  parentId: 3623,
  repository: "Nimbus/Nimbus",
  server: "acme-studio@unity",
};

function change(overrides: Partial<IChangesetFileChange>): IChangesetFileChange {
  return {
    baseRevisionId: -1,
    parentRevisionId: -1,
    path: "/Assets/Code/Foo.cs",
    repository: REPOSITORY,
    revisionId: 1,
    revisionType: RevisionType.TextFile,
    status: FileChangeStatus.Changed,
    ...overrides,
  };
}

function expectEmptySide(uri: Uri, serverPath: string): void {
  expect(uri.scheme).to.equal(revisionScheme);
  expect(uri.path).to.equal(serverPath);
  expect(parseRevisionQuery(uri)).to.eql({ empty: true, wkId: WORKSPACE_ID });
}

function expectRevisionSide(uri: Uri, serverPath: string, revisionId: number): void {
  expect(uri.scheme).to.equal(revisionScheme);
  expect(uri.path).to.equal(serverPath);
  expect(parseRevisionQuery(uri)).to.eql({ rep: REPOSITORY, revid: revisionId, wkId: WORKSPACE_ID });
}

describe("describeChangesetFileDiff", () => {
  context("When there is nothing to diff", () => {
    it("returns undefined for a directory", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        path: "/JSON/Seasons",
        revisionId: 12221,
        revisionType: RevisionType.Directory,
        status: FileChangeStatus.Added,
      }));

      expect(diff).to.be.undefined;
    });

    it("returns undefined for an unknown revision type", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        revisionType: RevisionType.Unknown,
      }));

      expect(diff).to.be.undefined;
    });

    it("returns undefined for a binary file", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        path: "/Assets/Art/Race UI/Icons/Icon_Pit_Alert.png",
        revisionId: 12344,
        revisionType: RevisionType.BinaryFile,
        status: FileChangeStatus.Added,
      }));

      expect(diff).to.be.undefined;
    });
  });

  context("When the item was added", () => {
    // cm reported a parent revision for this added row; it must not leak into the left side.
    const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
      parentRevisionId: 11401,
      path: "/Assets/AddressableAssetsData/AssetGroups/TrackSkin_Dunes.asset",
      revisionId: 11751,
      status: FileChangeStatus.Added,
    }))!;

    it("compares an empty document against the added revision", () => {
      expectEmptySide(diff.left, "/Assets/AddressableAssetsData/AssetGroups/TrackSkin_Dunes.asset");
      expectRevisionSide(diff.right, "/Assets/AddressableAssetsData/AssetGroups/TrackSkin_Dunes.asset", 11751);
    });

    it("titles the editor with the changeset", () => {
      expect(diff.title).to.equal("TrackSkin_Dunes.asset (added in cs:3624)");
    });
  });

  context("When the item was deleted", () => {
    it("compares the deleted revision against an empty document", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        path: "/Assets/Code/Racing/UI/UIAnimatedFlagIcon.cs",
        revisionId: 11586,
        status: FileChangeStatus.Deleted,
      }))!;

      expectRevisionSide(diff.left, "/Assets/Code/Racing/UI/UIAnimatedFlagIcon.cs", 11586);
      expectEmptySide(diff.right, "/Assets/Code/Racing/UI/UIAnimatedFlagIcon.cs");
      expect(diff.title).to.equal("UIAnimatedFlagIcon.cs (deleted in cs:3624)");
    });

    it("ignores the parent revision cm reports for some deleted rows", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        parentRevisionId: 10231,
        path: "/Jenkinsfile_track_import",
        revisionId: 10301,
        status: FileChangeStatus.Deleted,
      }))!;

      expectRevisionSide(diff.left, "/Jenkinsfile_track_import", 10301);
      expectEmptySide(diff.right, "/Jenkinsfile_track_import");
      expect(diff.title).to.equal("Jenkinsfile_track_import (deleted in cs:3624)");
    });
  });

  context("When the item was moved without changes", () => {
    const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
      oldPath: "/Assets/Code/Racing/UI/UISlowLapWarning.cs.meta",
      path: "/Assets/Code/Racing/UI/UILapTimeBanner.cs.meta",
      revisionId: 5631,
      status: FileChangeStatus.Moved,
    }))!;

    it("shows the same revision under the old and the new name", () => {
      expectRevisionSide(diff.left, "/Assets/Code/Racing/UI/UISlowLapWarning.cs.meta", 5631);
      expectRevisionSide(diff.right, "/Assets/Code/Racing/UI/UILapTimeBanner.cs.meta", 5631);
    });

    it("keeps both sides distinct documents", () => {
      expect(diff.left.toString()).to.not.equal(diff.right.toString());
    });

    it("titles the editor with both names and both changesets", () => {
      expect(diff.title).to.equal(
        "UISlowLapWarning.cs.meta (cs:3623) ↔ UILapTimeBanner.cs.meta (cs:3624)");
    });
  });

  context("When the item was changed", () => {
    it("compares the base revision in the parent changeset's tree against the new one", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        baseRevisionId: 11593,
        parentRevisionId: 11593,
        revisionId: 12347,
      }))!;

      expectRevisionSide(diff.left, "/Assets/Code/Foo.cs", 11593);
      expectRevisionSide(diff.right, "/Assets/Code/Foo.cs", 12347);
      expect(diff.title).to.equal("Foo.cs (cs:3623) ↔ Foo.cs (cs:3624)");
    });

    it("uses the old name on the left when the item was also moved", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        baseRevisionId: 11593,
        oldPath: "/Assets/Code/Racing/UI/UISlowLapWarning.cs",
        parentRevisionId: 11593,
        path: "/Assets/Code/Racing/UI/UILapTimeBanner.cs",
        revisionId: 12347,
        status: FileChangeStatus.Changed | FileChangeStatus.Moved,
      }))!;

      expectRevisionSide(diff.left, "/Assets/Code/Racing/UI/UISlowLapWarning.cs", 11593);
      expectRevisionSide(diff.right, "/Assets/Code/Racing/UI/UILapTimeBanner.cs", 12347);
      expect(diff.title).to.equal("UISlowLapWarning.cs (cs:3623) ↔ UILapTimeBanner.cs (cs:3624)");
    });

    it("falls back to the previous revision, labelled as such, when there is no base", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        parentRevisionId: 7,
        revisionId: 11,
      }))!;

      expectRevisionSide(diff.left, "/Assets/Code/Foo.cs", 7);
      expectRevisionSide(diff.right, "/Assets/Code/Foo.cs", 11);
      expect(diff.title).to.equal("Foo.cs (previous revision) ↔ Foo.cs (cs:3624)");
    });

    it("compares against an empty document when neither base nor previous revision exist", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        revisionId: 11,
      }))!;

      expectEmptySide(diff.left, "/Assets/Code/Foo.cs");
      expectRevisionSide(diff.right, "/Assets/Code/Foo.cs", 11);
      expect(diff.title).to.equal("Foo.cs (empty) ↔ Foo.cs (cs:3624)");
    });
  });

  context("When several status flags are set", () => {
    it("treats an added item as added whatever else is flagged", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        baseRevisionId: 5,
        revisionId: 11,
        status: FileChangeStatus.Added | FileChangeStatus.Changed,
      }))!;

      expectEmptySide(diff.left, "/Assets/Code/Foo.cs");
      expect(diff.title).to.equal("Foo.cs (added in cs:3624)");
    });

    it("treats a deleted item as deleted before considering a move", () => {
      const diff = describeChangesetFileDiff(WORKSPACE_ID, changeset, change({
        oldPath: "/Assets/Code/Old.cs",
        revisionId: 11,
        status: FileChangeStatus.Deleted | FileChangeStatus.Moved,
      }))!;

      expectRevisionSide(diff.left, "/Assets/Code/Foo.cs", 11);
      expectEmptySide(diff.right, "/Assets/Code/Foo.cs");
      expect(diff.title).to.equal("Foo.cs (deleted in cs:3624)");
    });
  });
});
