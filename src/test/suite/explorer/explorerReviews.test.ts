import { branchRowXml, EMPTY_QUERY, ReviewShell, reviewsXml } from "../reviews/fixtures";
import { indexExplorerReviews, reviewTargetId } from "../../../explorer/explorerReviews";
import { BranchExplorerData } from "../../../explorer/explorerData";
import { buildExplorerModel } from "../../../explorer/explorerGraph";
import { expect } from "chai";
import { IConfig } from "../../../config";
import { IReview } from "../../../reviews/models";
import { OutputChannel } from "vscode";
import { Workspace } from "../../../workspace";

const TASK = "/main/task";
const TASK_ID = 117;

function review(overrides: Partial<IReview>): IReview {
  return {
    assignee: "",
    date: "2026-09-21T16:03:49+01:00",
    id: 1,
    owner: "erin.author@example.com",
    status: "Under review",
    target: `id:${TASK_ID}`,
    targetType: "branch",
    title: "Double jump",
    ...overrides,
  };
}

describe("Branch Explorer reviews", () => {
  describe("reviewTargetId", () => {
    it("reads a branch object id and a changeset number", () => {
      expect(reviewTargetId({ target: "id:117" })).to.equal(117);
      expect(reviewTargetId({ target: "3203" })).to.equal(3203);
      expect(reviewTargetId({ target: "cs:3203" })).to.equal(3203);
      expect(reviewTargetId({ target: "lb:v1" })).to.equal(undefined);
    });
  });

  describe("indexExplorerReviews", () => {
    const names = new Map<number, string | undefined>([[ TASK_ID, TASK ], [ 200, undefined ]]);

    it("marks a branch by name and a changeset by number, each with its status", () => {
      const index = indexExplorerReviews([
        review({ id: 5, status: "Rework required" }),
        review({ id: 6, status: "Reviewed", target: "42", targetType: "changeset", title: "Fix the lobby" }),
      ], names);

      expect(Array.from(index.byBranch.keys())).to.eql([TASK]);
      expect(index.byBranch.get(TASK)).to.include({ id: 5, status: "reworkRequired" });
      expect(index.byChangeset.get(42)).to.include({ id: 6, status: "reviewed" });
      expect(index.byChangeset.get(42)?.tooltip).to.contain("Reviewed: review 6, Fix the lobby");
    });

    it("shows the newest review of a branch and names the earlier ones", () => {
      const mark = indexExplorerReviews([
        review({ id: 3, status: "Reviewed" }),
        review({ id: 9, status: "Under review", title: "Second round" }),
      ], names).byBranch.get(TASK);

      expect(mark).to.include({ id: 9, status: "underReview" });
      expect(mark?.tooltip.split("\n")).to.eql([
        "Under review: review 9, Second round",
        "Earlier: review 3, Reviewed",
        "Click to open the review",
      ]);
    });

    it("leaves out deleted branches, unknown statuses and other target types", () => {
      const index = indexExplorerReviews([
        review({ id: 1, target: "id:200" }),
        review({ id: 2, target: "id:999" }),
        review({ id: 3, status: "Pending" }),
        review({ id: 4, target: "id:117", targetType: "label" }),
      ], names);

      expect(index.byBranch.size).to.equal(0);
      expect(index.byChangeset.size).to.equal(0);
    });
  });

  describe("BranchExplorerData.loadReviews", () => {
    function changesetXml(id: number, parent: number, branch: string): string {
      return [
        "  <CHANGESET>",
        `    <ID>${1000 + id}</ID>`,
        `    <CHANGESETID>${id}</CHANGESETID>`,
        "    <COMMENT>Work</COMMENT>",
        "    <DATE>2026-11-16T16:13:15+00:00</DATE>",
        "    <OWNER>erin.author@example.com</OWNER>",
        "    <REPOSITORY>SkyRunner</REPOSITORY>",
        "    <REPNAME>SkyRunner</REPNAME>",
        "    <REPSERVER>local</REPSERVER>",
        `    <BRANCH>${branch}</BRANCH>`,
        `    <PARENT>${parent}</PARENT>`,
        `    <GUID>0497ef04-4c81-4090-8458-64988540${String(id).padStart(4, "0")}</GUID>`,
        "  </CHANGESET>",
      ].join("\n");
    }

    const CHANGESETS = "<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n<PLASTICQUERY>\n" +
      [ changesetXml(3, 2, TASK), changesetXml(2, 1, "/main"), changesetXml(1, -1, "/main") ].join("\n") +
      "\n</PLASTICQUERY>";

    function create(shell: ReviewShell): BranchExplorerData {
      const workspace = {
        currentChangeset: 2,
        info: { id: "wk", name: "SkyRunner", path: "/tmp/SkyRunner" },
        shell,
        workspaceConfig: undefined,
      } as unknown as Workspace;
      const channel = { appendLine: () => undefined } as unknown as OutputChannel;
      return new BranchExplorerData(workspace, channel, () => ({}) as IConfig, () => shell);
    }

    function answering(reviews: () => string): ReviewShell {
      const shell = new ReviewShell();
      shell.answer = (_command, args) => {
        switch (args[0]) {
        case "changeset":
          return CHANGESETS;
        case "review":
          return reviews();
        case "branch":
          return args[1].includes("hidden") ? EMPTY_QUERY : branchRowXml(TASK_ID, TASK, 3);
        default:
          return EMPTY_QUERY as string;
        }
      };
      return shell;
    }

    async function loaded(data: BranchExplorerData): Promise<void> {
      await data.load();
      // `load` starts the reviews without waiting for them.
      await data.loadReviews();
    }

    it("puts the review of a branch on its head once the graph has loaded", async () => {
      const shell = answering(() => reviewsXml([{ id: 129, target: `id:${TASK_ID}`, title: "Double jump" }]));
      const data = create(shell);
      try {
        expect(data.reviews.byBranch.size).to.equal(0);
        await loaded(data);

        const model = buildExplorerModel({
          changesets: data.changesets,
          currentChangesetId: 2,
          labels: data.labels,
          merges: data.merges,
          reviews: data.reviews,
          scope: { kind: "all" },
        });
        const head = model.rows.find(row => row.id === 3);
        expect(head?.refs[0].review).to.include({ id: 129, status: "underReview" });
        expect(shell.queries("review")[0]).to.equal("where id > 0 order by date desc limit 500");
      } finally {
        data.dispose();
      }
    });

    it("picks up a status change and names each branch once", async () => {
      let status = "Under review";
      const shell = answering(() => reviewsXml([{ id: 129, status, target: `id:${TASK_ID}` }]));
      const data = create(shell);
      try {
        await loaded(data);
        const named = shell.queries("branch").length;
        expect(named).to.be.greaterThan(0);

        status = "Reviewed";
        await data.loadReviews();
        expect(data.reviews.byBranch.get(TASK)).to.include({ id: 129, status: "reviewed" });
        expect(shell.queries("branch").length).to.equal(named);
      } finally {
        data.dispose();
      }
    });

    it("reads the reviews again on a timer until told to stop", async () => {
      const shell = answering(() => reviewsXml([{ id: 129, target: `id:${TASK_ID}` }]));
      const data = create(shell);
      const wait = (millis: number) => new Promise(resolve => setTimeout(resolve, millis));
      try {
        await loaded(data);
        const before = shell.queries("review").length;

        data.setReviewPolling(20);
        await wait(150);
        const polled = shell.queries("review").length;
        expect(polled).to.be.greaterThan(before);

        data.setReviewPolling(0);
        await wait(40);
        const stopped = shell.queries("review").length;
        await wait(100);
        expect(shell.queries("review").length).to.equal(stopped);
      } finally {
        data.dispose();
      }
    });

    it("keeps the graph and its badges when the reviews cannot be read", async () => {
      let fail = false;
      const shell = answering(() => {
        if (fail) {
          throw new Error("The server is not reachable.");
        }
        return reviewsXml([{ id: 129, target: `id:${TASK_ID}` }]);
      });
      const data = create(shell);
      try {
        await loaded(data);
        fail = true;
        await data.loadReviews();
        expect(data.status).to.equal("ready");
        expect(data.reviews.byBranch.get(TASK)?.id).to.equal(129);
      } finally {
        data.dispose();
      }
    });
  });
});
