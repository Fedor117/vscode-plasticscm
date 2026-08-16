import * as xml2js from "xml2js";
import { ChangeType, IChangeInfo, IPendingChanges, RevisionType, WkConfigType } from "../../../models";
import { firstCharLowerCase, parseBooleans, parseNumbers } from "xml2js/lib/processors";
import { BaseCmParser } from "../baseCmParser";
import { Uri } from "vscode";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export class StatusParser extends BaseCmParser<IPendingChanges> {
  public async parse(): Promise<IPendingChanges | undefined> {
    const options: xml2js.OptionsV2 = {
      explicitArray: false,
      explicitRoot: false,
      tagNameProcessors: [firstCharLowerCase],
      trim: true,
      valueProcessors: [ parseNumbers, parseBooleans ],
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return this.parseXml(await xml2js.parseStringPromise(
        this.mOutputBuffer.join(""), options));
    } catch (error) {
      this.mParseError = error as Error;
      return undefined;
    }
  }

  private parseXml(statusOutput: IStatusOutput): IPendingChanges {
    const repSpec: string = [
      statusOutput.workspaceStatus.status.repSpec.name,
      statusOutput.workspaceStatus.status.repSpec.server,
    ].join("@");

    const changes: Map<string, IChangeInfo> = new Map<string, IChangeInfo>();
    let pendingChanges: IChange[] = [];
    if (statusOutput.changes) {
      pendingChanges = pendingChanges.concat(statusOutput.changes.change);
    }

    pendingChanges.forEach(change => {
      const uri: Uri = Uri.file(normalizePath(change.path));
      const newChange: IChangeInfo = {
        oldPath: change.oldPath ? Uri.file(normalizePath(change.oldPath)) : undefined,
        path: uri,
        revisionType: REVISION_TYPES[change.revisionType] ?? RevisionType.Unknown,
        type: CHANGE_TYPES[change.type] ?? ChangeType.Controlled,
      };

      changes.set(uri.path, this.mergeChanges(changes.get(uri.path), newChange));
    });

    return {
      changes,
      changeset: statusOutput.workspaceStatus.status.changeset,
      workspaceConfig: {
        configType: statusOutput.wkConfigType,
        location: statusOutput.wkConfigName.replace(`@${repSpec}`, ""),
        repSpec,
      },
    };
  }

  private mergeChanges(
      destination: IChangeInfo | undefined, source: IChangeInfo): IChangeInfo {
    if (!destination) {
      return source;
    }

    return {
      oldPath: destination.oldPath ?? source.oldPath,
      path: destination.path,
      revisionType: destination.revisionType !== RevisionType.Unknown
        ? destination.revisionType
        : source.revisionType,
      type: destination.type | source.type,
    };
  }
}

interface IStatusOutput {
  workspaceStatus: {
    status: {
      repSpec: {
        server: string;
        name: string;
      };
      changeset: number;
    };
  };
  wkConfigType: WkConfigType;
  wkConfigName: string;
  changes: {
    change: IChange[];
  };
}

const REVISION_TYPES: { [key: string]: RevisionType } = {
  enBinaryFile: RevisionType.BinaryFile,
  enDirectory: RevisionType.Directory,
  enTextFile: RevisionType.TextFile,
};

/**
 * `IG` collapses into Private, which is safe only because status is run without
 * `--ignored` and so never reports an ignored item. Adding that flag would make
 * ignored files indistinguishable from private ones, and Discard Changes deletes
 * private items from disk — split the two before ever passing it.
 */
const CHANGE_TYPES: { [key: string]: ChangeType } = {
  AD: ChangeType.Added,
  CH: ChangeType.Changed,
  CO: ChangeType.Checkedout,
  CP: ChangeType.Checkedout,
  DE: ChangeType.Deleted,
  IG: ChangeType.Private,
  LD: ChangeType.Deleted,
  LM: ChangeType.Moved,
  MV: ChangeType.Moved,
  PR: ChangeType.Private,
  RP: ChangeType.Checkedout,
};

interface IChange {
  type: string;
  typeVerbose: string;
  path: string;
  oldPath: string;
  printableMovedPath: string;
  mergesInfo: string;
  similarityPerUnit: number;
  similarity: string;
  size: number;
  printableSize: string;
  printableLastModified: string;
  revisionType: string;
  lastModified: Date;
}
