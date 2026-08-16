import * as path from "path";
import { ChangeType, IChangeInfo, RevisionType } from "./models";
import {
  Command,
  FileDecoration,
  SourceControlResourceDecorations,
  SourceControlResourceState,
  ThemeColor,
  Uri,
} from "vscode";
import { memoize } from "./decorators";
import { toRevisionUri } from "./revisionContentProvider";
import { Workspace } from "./workspace";

const iconsRootPath = path.join(__dirname, "..", "images", "icons");

function getIconPath(iconName: string, theme: string): Uri {
  return Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
}

interface IIcons {
  [theme: string]: IIconSet;
}

interface IIconSet {
  added: Uri;
  changed: Uri;
  checkedout: Uri;
  deleted: Uri;
  moved: Uri;
  private: Uri;
}

/**
 * Change types in display precedence, each with the badge letter it contributes
 * and the token it publishes to menu `when` clauses.
 */
const CHANGE_FLAGS: ReadonlyArray<{ flag: ChangeType; letter: string; token: string }> = [
  { flag: ChangeType.Private, letter: "P", token: "private" },
  { flag: ChangeType.Added, letter: "A", token: "added" },
  { flag: ChangeType.Changed, letter: "C", token: "changed" },
  { flag: ChangeType.Moved, letter: "M", token: "moved" },
  { flag: ChangeType.Checkedout, letter: "CO", token: "checkedout" },
  { flag: ChangeType.Deleted, letter: "D", token: "deleted" },
];

/**
 * `file` is published alongside the specific type so menus can exclude directories
 * with a positive match. A directory is the only thing that never gets it, which
 * keeps entries like "Open File" off rows that cannot be opened in an editor.
 */
const REVISION_TOKENS: { [key in RevisionType]: string } = {
  [RevisionType.BinaryFile]: "file,binary",
  [RevisionType.Directory]: "directory",
  [RevisionType.TextFile]: "file,text",
  [RevisionType.Unknown]: "file",
};

export class PlasticScmResource implements SourceControlResourceState {
  private static icons: IIcons = {
    dark: {
      added: getIconPath("status-added", "dark"),
      changed: getIconPath("status-modified", "dark"),
      checkedout: getIconPath("status-modified", "dark"),
      deleted: getIconPath("status-deleted", "dark"),
      moved: getIconPath("status-renamed", "dark"),
      private: getIconPath("status-unversioned", "dark"),
    },
    light: {
      added: getIconPath("status-added", "light"),
      changed: getIconPath("status-modified", "light"),
      checkedout: getIconPath("status-modified", "light"),
      deleted: getIconPath("status-deleted", "light"),
      moved: getIconPath("status-renamed", "light"),
      private: getIconPath("status-unversioned", "light"),
    },
  };

  private mChangeInfo: IChangeInfo;
  private mWorkspace: Workspace;

  public constructor(changeInfo: IChangeInfo, workspace: Workspace) {
    this.mChangeInfo = changeInfo;
    this.mWorkspace = workspace;
  }

  @memoize
  public get resourceUri(): Uri {
    return this.mChangeInfo.path;
  }

  public get isPrivate(): boolean {
    return (this.mChangeInfo.type & ChangeType.Private) !== 0;
  }

  public get type(): ChangeType {
    return this.mChangeInfo.type;
  }

  /**
   * Backs `scmResourceState` in menu `when` clauses. Every applicable token is
   * listed rather than just the dominant one, so a file that is both checked out
   * and changed still matches `scmResourceState =~ /checkedout/`. Without this,
   * no menu entry can vary by change type — which is why "Undo Checkout" is
   * currently offered on private files.
   */
  public get contextValue(): string {
    const tokens: string[] = this.changeFlags.map(entry => entry.token);
    tokens.push(REVISION_TOKENS[this.mChangeInfo.revisionType]);

    return tokens.join(",");
  }

  public get isDirectory(): boolean {
    return this.mChangeInfo.revisionType === RevisionType.Directory;
  }

  public get decorations(): SourceControlResourceDecorations {
    return {
      dark: undefined, // leave undefined to use the other decorations instead of icons
      faded: false, // Maybe in the future for ignored items
      light: undefined, // leave undefined to use the other decorations instead of icons
      strikeThrough: this.mChangeInfo.type === ChangeType.Deleted,
      tooltip: this.tooltip,
    };
  }

  public get resourceDecoration(): FileDecoration {
    const res = new FileDecoration(this.letter, this.tooltip, this.color);
    res.propagate = this.mChangeInfo.type !== ChangeType.Deleted;
    return res;
  }

  public get letter(): string {
    return this.changeFlags.map(entry => entry.letter).join("");
  }

  public get color(): ThemeColor | undefined {
    if (this.mChangeInfo.type & ChangeType.Private) {
      return new ThemeColor("gitDecoration.untrackedResourceForeground");
    }

    if (this.mChangeInfo.type & ChangeType.Added) {
      return new ThemeColor("gitDecoration.addedResourceForeground");
    }

    if (this.mChangeInfo.type & ChangeType.Changed) {
      return new ThemeColor("gitDecoration.modifiedResourceForeground");
    }

    if (this.mChangeInfo.type & ChangeType.Moved) {
      return new ThemeColor("gitDecoration.modifiedResourceForeground");
    }

    if (this.mChangeInfo.type & ChangeType.Checkedout) {
      return new ThemeColor("gitDecoration.modifiedResourceForeground");
    }

    if (this.mChangeInfo.type & ChangeType.Deleted) {
      return new ThemeColor("gitDecoration.deletedResourceForeground");
    }

    return undefined;
  }

  public get command(): Command | undefined {
    const unallowedFlag =
      ChangeType.Added |
      ChangeType.Private |
      ChangeType.Moved |
      ChangeType.Deleted;

    // cm already told us the revision type, so there is nothing to sniff off disk.
    if (
      this.mWorkspace.currentChangeset < 0 ||
      this.mChangeInfo.revisionType !== RevisionType.TextFile ||
      (this.mChangeInfo.type & unallowedFlag) !== 0
    ) {
      return undefined;
    }

    const originalFile = toRevisionUri(
      this.mWorkspace.info.id,
      this.resourceUri,
      this.mWorkspace.currentChangeset,
    );

    return {
      arguments: [
        originalFile,
        this.resourceUri,
        `${path.basename(this.resourceUri.fsPath)} (Diff)`,
      ],
      command: "vscode.diff",
      title: "Open",
    };
  }

  private get changeFlags(): ReadonlyArray<{ flag: ChangeType; letter: string; token: string }> {
    return CHANGE_FLAGS.filter(entry => (this.mChangeInfo.type & entry.flag) !== 0);
  }

  private get tooltip(): string {
    if (this.mChangeInfo.type & ChangeType.Moved) {
      return `Moved from ${this.mChangeInfo.oldPath?.fsPath || ""}`;
    }

    if (this.mChangeInfo.type & ChangeType.Private) {
      return "Private";
    }

    if (this.mChangeInfo.type & ChangeType.Added) {
      return "Added";
    }

    if (this.mChangeInfo.type & ChangeType.Changed) {
      return "Changed";
    }

    if (this.mChangeInfo.type & ChangeType.Moved) {
      return "Moved";
    }

    if (this.mChangeInfo.type & ChangeType.Checkedout) {
      return "Checked Out";
    }

    if (this.mChangeInfo.type & ChangeType.Deleted) {
      return "Deleted";
    }

    return "Unknown";
  }

  private static getIconPath(changeType: ChangeType, theme: string): Uri {
    const icons = PlasticScmResource.icons[theme];
    if (!icons) {
      throw new Error(`Unknown theme: ${theme}`);
    }

    if (changeType & ChangeType.Private) {
      return icons.private;
    }

    if (changeType & ChangeType.Added) {
      return icons.added;
    }

    if (changeType & ChangeType.Changed) {
      return icons.changed;
    }

    if (changeType & ChangeType.Moved) {
      return icons.moved;
    }

    if (changeType & ChangeType.Checkedout) {
      return icons.checkedout;
    }

    if (changeType & ChangeType.Deleted) {
      return icons.deleted;
    }

    throw new Error(`Unknown ChangeType: ${changeType}`);
  }
}
