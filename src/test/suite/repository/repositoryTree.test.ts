import { branchesSection, REPOSITORY_SECTIONS, shelvesSection } from "../../../repository/repositorySections";
import { EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState } from "vscode";
import { IBranchInfo, IListPage, IListQuery, IShelveInfo, IWorkspaceConfig, WkConfigType } from "../../../models";
import {
  IRepositoryErrorNode,
  IRepositoryItemNode,
  IRepositoryLoadMoreNode,
  IRepositorySection,
  IRepositorySectionNode,
  IRepositoryWorkspace,
  IRepositoryWorkspaceNode,
  REPOSITORY_COMMANDS,
  RepositoryNode,
  RepositoryTreeProvider,
} from "../../../repository/repositoryTreeProvider";
import { IShellMock, mockShellAnswering } from "../cm/commands/findChangesets/shellMock";
import { expect } from "chai";
import { ICmShell } from "../../../cm/shell";

interface IFakeWorkspace extends IRepositoryWorkspace {
  workspaceConfig?: IWorkspaceConfig;
  readonly status: EventEmitter<void>;
}

function fakeWorkspace(id: string, shell?: ICmShell, config?: IWorkspaceConfig): IFakeWorkspace {
  const status = new EventEmitter<void>();
  return {
    info: { id, name: `Nimbus-${id}`, path: `/work/${id}` },
    onDidRunStatus: status.event,
    shell: shell ?? ({} as ICmShell),
    status,
    workspaceConfig: config,
  };
}

function branchConfig(location: string): IWorkspaceConfig {
  return { configType: WkConfigType.Branch, location, repSpec: "Nimbus/Nimbus@acme-studio@unity" };
}

/** A section that answers each load from a queue of deferred pages, so tests control timing. */
class FakeSection implements IRepositorySection<string> {
  public readonly emptyMessage = "Nothing here";
  public readonly icon = "lock";
  public readonly id = "things";
  public readonly label = "Things";
  public readonly pageSize = 2;
  public readonly queries: IListQuery[] = [];
  private readonly mPending: Array<{ resolve(page: IListPage<string>): void; reject(error: Error): void }> = [];

  public load(_workspace: IRepositoryWorkspace, query: IListQuery): Promise<IListPage<string>> {
    this.queries.push(query);
    return new Promise((resolve, reject) => this.mPending.push({ reject, resolve }));
  }

  public key(item: string): string {
    return item;
  }

  public toTreeItem(item: string): TreeItem {
    const row = new TreeItem(item);
    row.contextValue = "thing";
    return row;
  }

  public async answer(items: string[], hasMore: boolean): Promise<void> {
    this.mPending.shift()!.resolve({ hasMore, items });
    await settle();
  }

  public async fail(message: string): Promise<void> {
    this.mPending.shift()!.reject(new Error(message));
    await settle();
  }
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function labelOf(item: TreeItem): string {
  return typeof item.label === "string" ? item.label : item.label!.label;
}

function branch(name: string): IBranchInfo {
  return {
    comment: "First line\nsecond line",
    date: new Date("2026-08-31T12:59:54+01:00"),
    guid: "b2a4c6d8-0e1f-4a3b-8c5d-6e7f8a9b0c1d",
    headChangesetId: 12,
    name,
    owner: "someone@example.com",
    parent: "/main",
    repository: "Nimbus/Nimbus",
    server: "acme-studio@unity",
  };
}

describe("Repository view", () => {
  let fired: Array<RepositoryNode | undefined>;
  let provider: RepositoryTreeProvider;

  afterEach(() => provider?.dispose());

  function create(workspaces: IRepositoryWorkspace[], sections: Array<IRepositorySection<unknown>>): void {
    provider = new RepositoryTreeProvider(() => workspaces, sections);
    fired = [];
    provider.onDidChangeTreeData(node => fired.push(node));
  }

  context("With one workspace", () => {
    let section: FakeSection;
    let workspace: IFakeWorkspace;

    beforeEach(() => {
      section = new FakeSection();
      workspace = fakeWorkspace("w1");
      create([workspace], [section as IRepositorySection<unknown>]);
    });

    const sectionNode = () => provider.getChildren()[0] as IRepositorySectionNode;

    it("shows the sections at the root, collapsed, and queries nothing", () => {
      const roots = provider.getChildren();
      expect(roots.map(node => node.kind)).to.eql(["section"]);
      const item = provider.getTreeItem(roots[0]);
      expect(labelOf(item)).to.equal("Things");
      expect(item.collapsibleState).to.equal(TreeItemCollapsibleState.Collapsed);
      expect(item.contextValue).to.equal("section.things");
      expect((item.iconPath as ThemeIcon).id).to.equal("lock");
      expect(section.queries).to.eql([]);
    });

    it("keeps the same node objects across calls", () => {
      expect(provider.getChildren()[0]).to.equal(provider.getChildren()[0]);
    });

    it("loads the first page on expansion and shows a loading row meanwhile", async () => {
      const loading = provider.getChildren(sectionNode());
      expect(section.queries).to.eql([{ limit: 2, offset: 0 }]);
      expect(loading.map(node => node.kind === "message" && node.label)).to.eql(["Loading…"]);

      await section.answer([ "a", "b" ], false);
      expect(fired).to.eql([sectionNode()]);
      const rows = provider.getChildren(sectionNode()) as Array<IRepositoryItemNode<string>>;
      expect(rows.map(row => row.item)).to.eql([ "a", "b" ]);
      expect(rows.every(row => row.workspace === workspace && row.parent === sectionNode())).to.be.true;
      const item = provider.getTreeItem(rows[0]);
      expect(item.id).to.equal("section:w1/things/item:a");
      expect(item.contextValue).to.equal("thing");
      expect(section.queries).to.have.lengthOf(1);
    });

    it("shows the section's empty message", async () => {
      provider.getChildren(sectionNode());
      await section.answer([], false);
      expect(provider.getChildren(sectionNode()).map(node => node.kind === "message" && node.label))
        .to.eql(["Nothing here"]);
    });

    it("pages with Load More and drops duplicates", async () => {
      provider.getChildren(sectionNode());
      await section.answer([ "c", "b" ], true);

      const rows = provider.getChildren(sectionNode());
      const more = rows[rows.length - 1] as IRepositoryLoadMoreNode;
      expect(more.kind).to.equal("loadMore");
      const moreItem = provider.getTreeItem(more);
      expect(moreItem.contextValue).to.equal("loadMore");
      expect(moreItem.command?.command).to.equal(REPOSITORY_COMMANDS.loadMore);
      expect(moreItem.command?.arguments).to.eql([more]);

      const loadMore = provider.loadMore(more);
      expect(section.queries[1]).to.eql({ limit: 2, offset: 2 });
      expect(labelOf(provider.getTreeItem(more))).to.equal("Loading more…");
      expect(provider.getTreeItem(more).command).to.be.undefined;
      await section.answer([ "b", "a" ], false);
      await loadMore;

      const after = provider.getChildren(sectionNode());
      expect(after.map(node => node.kind === "item" && node.item)).to.eql([ "c", "b", "a" ]);
    });

    it("shows an error row that retries", async () => {
      provider.getChildren(sectionNode());
      await section.fail("Error: The server is unreachable");

      const [error] = provider.getChildren(sectionNode()) as IRepositoryErrorNode[];
      expect(error.kind).to.equal("error");
      const item = provider.getTreeItem(error);
      expect(labelOf(item)).to.equal("Couldn't load: The server is unreachable");
      expect(item.contextValue).to.equal("error");
      expect(item.command?.command).to.equal(REPOSITORY_COMMANDS.retry);

      const retry = provider.retry(error);
      expect(section.queries).to.have.lengthOf(2);
      await section.answer(["a"], false);
      await retry;
      expect(provider.getChildren(sectionNode()).map(node => node.kind)).to.eql(["item"]);
    });

    it("reloads every section on refresh, and ignores a page that arrives after it", async () => {
      provider.getChildren(sectionNode());
      provider.refresh();
      expect(fired).to.eql([undefined]);

      provider.getChildren(sectionNode());
      await section.answer(["stale"], false);
      await section.answer(["fresh"], false);
      expect(provider.getChildren(sectionNode()).map(node => node.kind === "item" && node.item)).to.eql(["fresh"]);
    });

    it("re-renders, without reloading, when the workspace moves", async () => {
      provider.getChildren(sectionNode());
      await section.answer(["a"], false);
      fired.length = 0;

      workspace.status.fire();
      expect(fired).to.eql([]);

      workspace.workspaceConfig = branchConfig("/main/task001");
      workspace.status.fire();
      expect(fired).to.eql([undefined]);
      provider.getChildren(sectionNode());
      expect(section.queries).to.have.lengthOf(1);
    });
  });

  context("With several workspaces", () => {
    it("groups the sections by workspace", () => {
      const first = fakeWorkspace("w1", undefined, branchConfig("/main"));
      const second = fakeWorkspace("w2");
      create([ first, second ], [new FakeSection() as IRepositorySection<unknown>]);

      const roots = provider.getChildren() as IRepositoryWorkspaceNode[];
      expect(roots.map(node => node.kind)).to.eql([ "workspace", "workspace" ]);
      const item = provider.getTreeItem(roots[0]);
      expect(labelOf(item)).to.equal("Nimbus-w1");
      expect(item.description).to.equal("Nimbus/Nimbus@acme-studio@unity");
      expect(item.contextValue).to.equal("workspace");
      expect(item.collapsibleState).to.equal(TreeItemCollapsibleState.Expanded);

      const sections = provider.getChildren(roots[1]) as IRepositorySectionNode[];
      expect(sections.map(node => node.id)).to.eql(["section:w2/things"]);
      expect(sections[0].workspace).to.equal(second);
      expect(provider.getParent(sections[0])).to.equal(roots[1]);
    });
  });

  context("With the built-in sections", () => {
    it("lists Branches, Labels, Shelves and Locks in that order", () => {
      expect(REPOSITORY_SECTIONS.map(section => section.id)).to.eql([ "branches", "labels", "shelves", "locks" ]);
    });

    it("loads branches through the workspace's shell and marks the current one", async () => {
      const shell: IShellMock = mockShellAnswering(() => ({
        result: [ branch("/main/task001"), branch("/main") ], success: true,
      }));
      create(
        [fakeWorkspace("w1", shell.mock.object, branchConfig("/main/task001"))],
        [branchesSection as IRepositorySection<unknown>]);

      const branches = provider.getChildren()[0];
      provider.getChildren(branches);
      await settle();

      expect(shell.calls[0].args[1]).to.equal("order by date desc limit 51");
      const rows = provider.getChildren(branches) as Array<IRepositoryItemNode<IBranchInfo>>;
      const current = provider.getTreeItem(rows[0]);
      const other = provider.getTreeItem(rows[1]);
      expect(labelOf(current)).to.equal("/main/task001");
      expect(current.contextValue).to.equal("branch.current");
      expect(String(current.description)).to.match(/^current · someone@example\.com · /);
      expect(current.tooltip as string).to.contain("Comment: First line\nsecond line");
      expect(other.contextValue).to.equal("branch");
      expect(String(other.description)).to.match(/^someone@example\.com · /);
    });

    it("names shelves sh:N and describes them by comment", () => {
      const shelve: IShelveInfo = {
        comment: "WIP: inventory\nmore",
        date: new Date(0),
        guid: "",
        id: 1,
        owner: "someone@example.com",
        parentChangesetId: 7,
        repository: "Nimbus/Nimbus",
        server: "acme-studio@unity",
        shelveId: 48,
      };
      const item = shelvesSection.toTreeItem(shelve, fakeWorkspace("w1", undefined, {
        configType: WkConfigType.Shelve, location: "sh:48", repSpec: "Nimbus/Nimbus@acme-studio@unity",
      }));
      expect(labelOf(item)).to.equal("sh:48");
      expect(item.description).to.equal("current · WIP: inventory · someone@example.com");
      expect(item.contextValue).to.equal("shelve.current");
    });
  });
});

describe("Rows with children", () => {
  interface IWordSection extends IRepositorySection<string> {
    readonly loaded: string[];
    fail: boolean;
  }

  /** A section whose rows expand into their letters. */
  function wordSection(): IWordSection {
    const section: IWordSection = {
      childKey: child => String(child),
      childToTreeItem: child => {
        const row = new TreeItem(String(child));
        row.command = { command: "words.open", title: "Open" };
        row.contextValue = "letter";
        return row;
      },
      emptyMessage: "none",
      fail: false,
      icon: "book",
      id: "words",
      key: item => `k${item}`,
      label: "Words",
      load: () => Promise.resolve({ hasMore: false, items: [ "ab", "" ] }),
      loadChildren: item => {
        section.loaded.push(item);
        return section.fail ? Promise.reject(new Error("boom")) : Promise.resolve(item.split(""));
      },
      loaded: [],
      pageSize: 5,
      toTreeItem: item => new TreeItem(item || "(empty)"),
    };
    return section;
  }

  let provider: RepositoryTreeProvider;
  let section: IWordSection;

  beforeEach(async () => {
    section = wordSection();
    provider = new RepositoryTreeProvider(
      () => [fakeWorkspace("w1")], [section as IRepositorySection<unknown>]);
    provider.getChildren(provider.getChildren()[0]);
    await settle();
  });

  afterEach(() => provider.dispose());

  const rows = () => provider.getChildren(provider.getChildren()[0]) as IRepositoryItemNode[];

  it("makes rows expandable when the section can load children", () => {
    expect(provider.getTreeItem(rows()[0]).collapsibleState).to.equal(TreeItemCollapsibleState.Collapsed);
  });

  it("loads the children once, on expansion, and shows a loading row meanwhile", async () => {
    const loading = provider.getChildren(rows()[0]);
    expect(loading.map(node => node.kind === "message" && node.label)).to.eql(["Loading…"]);
    await settle();

    const children = provider.getChildren(rows()[0]);
    expect(children.map(node => node.kind)).to.eql([ "child", "child" ]);
    provider.getChildren(rows()[0]);
    expect(section.loaded).to.eql(["ab"]);
  });

  it("passes the child node to the row's command", async () => {
    provider.getChildren(rows()[0]);
    await settle();
    const child = provider.getChildren(rows()[0])[0];
    const item = provider.getTreeItem(child);
    expect(item.contextValue).to.equal("letter");
    expect(item.command?.arguments).to.eql([child]);
    expect(provider.getParent(child)).to.eql(rows()[0]);
  });

  it("says when a row has nothing under it", async () => {
    provider.getChildren(rows()[1]);
    await settle();
    const children = provider.getChildren(rows()[1]);
    expect(children.map(node => node.kind === "message" && node.label)).to.eql(["Nothing to show"]);
  });

  it("shows a failed load as a row and loads again after a refresh", async () => {
    section.fail = true;
    provider.getChildren(rows()[0]);
    await settle();
    const failed = provider.getChildren(rows()[0]);
    expect(failed.map(node => node.kind === "message" && node.label)).to.eql(["Couldn't load: boom"]);

    section.fail = false;
    provider.refresh();
    provider.getChildren(provider.getChildren()[0]);
    await settle();
    provider.getChildren(rows()[0]);
    await settle();
    expect(provider.getChildren(rows()[0]).map(node => node.kind)).to.eql([ "child", "child" ]);
  });
});

