import { branchRowXml, comment, EMPTY_QUERY, ReviewShell, reviewsXml } from "../reviews/fixtures";
import {
  indexExplorerReviews, markOnBranch, reviewedDates, reviewTargetId,
} from "../../../explorer/explorerReviews";
import { BranchExplorerData } from "../../../explorer/explorerData";
import { buildExplorerModel } from "../../../explorer/explorerGraph";
import { expect } from "chai";
import { IConfig } from "../../../config";
import { IHistoryChangeset } from "../../../models";
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
      expect(index.byBranch.get(TASK)).to.include({ id: 5, label: "Rework required", status: "reworkRequired" });
      expect(index.byChangeset.get(42)).to.include({ id: 6, label: "Reviewed", status: "reviewed" });
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

  describe("reviewedDates", () => {
    it("takes the last time each review was marked Reviewed, from its timeline rows alone", () => {
      const row = (reviewId: number, text: string, date: string, type = "timeline") =>
        comment({ date, reviewId, text, type });
      const dates = reviewedDates([
        row(5, "[status-reviewed]", "2026-11-16T18:21:35+00:00"),
        row(5, "[status-rework-required]Fix the jump", "2026-11-16T19:00:00+00:00"),
        row(5, "[status-reviewed]Good now", "2026-11-16T20:00:00+00:00"),
        row(5, "[status-reviewed] quoted in a comment", "2026-11-17T09:00:00+00:00", "comment"),
        row(6, "[requested-review-from]dana.kim", "2026-11-16T18:20:44+00:00"),
      ]);
      expect(Array.from(dates)).to.eql([[ 5, Date.parse("2026-11-16T20:00:00+00:00") ]]);
    });
  });

  describe("markOnBranch", () => {
    const mark = {
      id: 9,
      label: "Reviewed",
      reviewedAt: Date.UTC(2026, 10, 16, 12),
      status: "reviewed" as const,
      tooltip: "Reviewed: review 9, Double jump\nClick to open the review",
    };
    const checkedIn = (id: number, parentId: number, hour: number): IHistoryChangeset =>
      ({ branch: TASK, date: new Date(Date.UTC(2026, 10, 16, hour)), id, parentId }) as IHistoryChangeset;
    const everyLoaded = (): boolean => true;

    it("leaves a review that covers the head, or has no date, as it is", () => {
      expect(markOnBranch(mark, [ checkedIn(7, 6, 11), checkedIn(6, 5, 10) ], everyLoaded)).to.equal(mark);
      const undated = { ...mark, reviewedAt: undefined };
      expect(markOnBranch(undated, [checkedIn(8, 7, 14)], everyLoaded)).to.equal(undated);
    });

    it("counts the changesets checked in after the review and says so in the tooltip", () => {
      const one = markOnBranch(mark, [ checkedIn(8, 7, 14), checkedIn(7, 6, 11) ], everyLoaded);
      expect(one).to.include({ id: 9, label: "Reviewed · 1 new", status: "reviewedEarlier" });
      expect(one.tooltip.split("\n")).to.eql([
        "Reviewed: review 9, Double jump",
        "1 changeset was checked in after it was marked Reviewed",
        "Click to open the review",
      ]);
    });

    it("counts at least as many when older changesets of the branch may not be loaded", () => {
      const newer = [ checkedIn(8, 7, 14), checkedIn(7, 6, 13) ];
      expect(markOnBranch(mark, newer, () => false).label).to.equal("Reviewed · 2+ new");
      // The oldest one's parent is loaded, on another branch: nothing older can be missing.
      expect(markOnBranch(mark, newer, everyLoaded).label).to.equal("Reviewed · 2 new");
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

    /** `[status-reviewed]` rows of review 129, as cm lists a review's timeline. */
    function reviewedXml(...dates: string[]): string {
      const rows = dates.map((date, index) => [
        "  <CHANGEREVIEWCOMMENT>",
        `    <ID>${133 + index}</ID>`,
        "    <OWNER>dana.kim</OWNER>",
        `    <DATE>${date}</DATE>`,
        "    <COMMENT>[status-reviewed]</COMMENT>",
        "    <REVISIONID>-1</REVISIONID>",
        "    <REVIEWID>129</REVIEWID>",
        "    <LOCATION>-1</LOCATION>",
        "    <TYPE>timeline</TYPE>",
        "    <PARENT>-1</PARENT>",
        "    <CHANGESET>-1</CHANGESET>",
        "    <APPLIEDINCHANGESET>-1</APPLIEDINCHANGESET>",
        "  </CHANGEREVIEWCOMMENT>",
      ].join("\n"));
      return `<?xml version="1.0" encoding="utf-8" ?>\n<PLASTICQUERY>\n${rows.join("\n")}\n</PLASTICQUERY>`;
    }

    function answering(reviews: () => string, timeline: () => string = () => EMPTY_QUERY): ReviewShell {
      const shell = new ReviewShell();
      shell.answer = (_command, args) => {
        switch (args[0]) {
        case "changeset":
          return CHANGESETS;
        case "changereviewcomment":
          return timeline();
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

    it("flags a Reviewed branch that got a changeset afterwards, and asks again while it looks outdated", async () => {
      // The head of the task branch is checked in at 16:13:15.
      let timeline = reviewedXml("2026-11-16T16:00:00+00:00");
      const shell = answering(
        () => reviewsXml([{ id: 129, status: "Reviewed", target: `id:${TASK_ID}` }]), () => timeline);
      const data = create(shell);
      const headReview = () => buildExplorerModel({
        changesets: data.changesets,
        currentChangesetId: 2,
        labels: data.labels,
        merges: data.merges,
        reviews: data.reviews,
        scope: { kind: "all" },
      }).rows.find(row => row.id === 3)?.refs[0].review;
      try {
        await loaded(data);
        expect(headReview()).to.include({ id: 129, label: "Reviewed · 1 new", status: "reviewedEarlier" });
        const asked = shell.queries("changereviewcomment");
        expect(asked[0]).to.equal("where type = 'timeline' and (reviewid = 129)");

        // A reviewer marks it Reviewed again: the review's status stays what it was.
        timeline = reviewedXml("2026-11-16T16:00:00+00:00", "2026-11-16T17:00:00+00:00");
        await data.loadReviews();
        expect(headReview()).to.include({ id: 129, label: "Reviewed", status: "reviewed" });

        // A date that covers the head is not asked for again.
        const settled = shell.queries("changereviewcomment").length;
        await data.loadReviews();
        expect(shell.queries("changereviewcomment").length).to.equal(settled);
      } finally {
        data.dispose();
      }
    });

    it("leaves a Reviewed branch as it is when its timeline does not say when", async () => {
      const shell = answering(() => reviewsXml([{ id: 129, status: "Reviewed", target: `id:${TASK_ID}` }]));
      const data = create(shell);
      try {
        await loaded(data);
        expect(data.reviews.byBranch.get(TASK)).to.include({ id: 129, status: "reviewed" });
        expect(data.reviews.byBranch.get(TASK)?.reviewedAt).to.equal(undefined);

        const asked = shell.queries("changereviewcomment").length;
        await data.loadReviews();
        expect(shell.queries("changereviewcomment").length).to.equal(asked);
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
