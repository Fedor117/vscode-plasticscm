import * as os from "os";
import * as path from "path";
import {
  ADDED_PATH,
  ANALYTICS_PATH,
  AUTHOR,
  BASE,
  BRANCH_ID,
  BRANCH_NAME,
  BRANCH_REVIEW_ID,
  branchRowXml,
  branchXml,
  CHANGESET_REVIEW_ID,
  changesetsXml,
  comment,
  COMMENT_XML,
  commentsXml,
  defaultAnswer,
  DELETED_PATH,
  EMPTY_QUERY,
  HEAD,
  HIDDEN_BRANCH_ID,
  HIDDEN_BRANCH_NAME,
  HIDDEN_BRANCH_REVIEW_XML,
  LAP_TIMER_PATH,
  ME,
  MERGED_PATH,
  PHANTOM_PATH,
  PLAIN_ROW_COUNT,
  REPOSITORY,
  REVIEW_XML,
  ReviewShell,
  reviewsXml,
  REVISIONS,
  revisionsXml,
  SCENARIO_COMMENTS,
  scenarioAnswer,
  WORKSPACE_ROOT,
} from "./fixtures";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { fileKey, IReview, IReviewRevision } from "../../../reviews/models";
import { isReviewLoadCancelled, ReviewService, targetNumber, toServerPath } from "../../../reviews/reviewService";
import { Uri, window } from "vscode";
import { expect } from "chai";
import { FileChangeStatus } from "../../../models";

const config = { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 1000, millisToWaitUntilUp: 1000 };

async function failure(action: Promise<unknown>): Promise<Error> {
  try {
    await action;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected a rejection");
}

function revision(id: number): IReviewRevision {
  const row = REVISIONS.find(candidate => candidate.id === id)!;
  return {
    branch: row.branch,
    changesetId: row.changeset,
    id: row.id,
    itemId: row.itemId,
    parentId: row.parent,
    path: WORKSPACE_ROOT + row.path,
    repository: REPOSITORY,
    type: "txt",
  };
}

describe("Review service", () => {
  const channel = window.createOutputChannel("Review service tests");
  let shell: ReviewShell;
  let service: ReviewService;
  const scenarioReview = async (id = BRANCH_REVIEW_ID): Promise<IReview> => (await service.review(id))!;
  beforeEach(() => {
    shell = new ReviewShell();
    shell.answer = scenarioAnswer;
    service = new ReviewService("wk", WORKSPACE_ROOT, channel, config, shell);
  });
  afterEach(() => service.dispose());
  after(() => channel.dispose());

  describe("files stage", () => {
    it("keeps every row of the plain branch diff and marks rows only merges changed", async () => {
      const files = await service.loadFiles(await scenarioReview());
      expect(files.final.files).to.have.length(PLAIN_ROW_COUNT);
      expect(files.final.kind).to.equal("final");
      const merged = files.final.files.filter(row => files.mergedKeys.has(fileKey(row))).map(row => row.path);
      expect(merged).to.have.members([ MERGED_PATH, PHANTOM_PATH ]);
      expect(files.merges.map(link => link.destinationChangesetId)).to.deep.equal([ 3477, 3699 ]);
      const diffs = shell.calls.filter(call => call.command === "diff");
      expect(diffs.map(call => call.args[0])).to.deep.equal([ `br:${BRANCH_NAME}`, `br:${BRANCH_NAME}` ]);
      expect(diffs[0].args).not.to.include("--clean");
      expect(diffs[1].args).to.include("--clean");
      expect(shell.queries("merge")).to.deep.equal([
        `where dstbranch = 'br:${BRANCH_NAME}' and dstchangeset <= ${HEAD}`,
      ]);
    });

    it("keeps the plain diff's sides for merged-in rows and folds a moved-and-edited pair", async () => {
      const files = await service.loadFiles(await scenarioReview());
      const merged = files.final.files.find(row => row.path === MERGED_PATH)!;
      expect(merged).to.include({ baseRevisionId: 10001, revisionId: 11081 });
      const moved = files.final.files.find(row => row.oldPath !== undefined)!;
      expect(moved.status).to.equal(FileChangeStatus.Changed | FileChangeStatus.Moved);
      expect(moved.baseRevisionId).to.equal(11242);
    });

    it("skips the --clean diff when nothing was merged into the branch", async () => {
      shell.answer = (command, args) => args[0] === "merge" ? EMPTY_QUERY : scenarioAnswer(command, args);
      const files = await service.loadFiles(await scenarioReview());
      expect(files.mergedKeys.size).to.equal(0);
      expect(files.merges).to.deep.equal([]);
      expect(shell.calls.some(call => call.args.includes("--clean"))).to.equal(false);
    });

    it("names the branch base and head in the comparison label", async () => {
      const files = await service.loadFiles(await scenarioReview());
      expect(files).to.include({ base: BASE, head: HEAD });
      expect(files.final).to.include({
        baseChangesetId: BASE, headChangesetId: HEAD, label: `cs:${BASE} ↔ cs:${HEAD}`,
      });
      expect(files.branch).to.deep.equal({
        headChangesetId: HEAD, hidden: false, id: BRANCH_ID, name: BRANCH_NAME, parent: "/main",
      });
      expect(shell.queries("changeset")).to.deep.equal([
        `where branch = '${BRANCH_NAME}' and ignorehidden = 'true' order by changesetid asc limit 1`,
      ]);
    });

    it("says 'base' when the branch's first changeset cannot be found", async () => {
      shell.answer = (command, args) =>
        args[0] === "changeset" ? EMPTY_QUERY : scenarioAnswer(command, args);
      const files = await service.loadFiles(await scenarioReview());
      expect(files.base).to.equal(undefined);
      expect(files.final.label).to.equal(`base ↔ cs:${HEAD}`);
    });

    it("says a branch without changesets of its own has none yet, not a base", async () => {
      shell.answer = (command, args) => command === "diff" ? ""
        : args[0] === "changeset" || args[0] === "merge" ? EMPTY_QUERY : scenarioAnswer(command, args);
      const files = await service.loadFiles(await scenarioReview());
      expect(files.final.files).to.deep.equal([]);
      expect(files.final.label).to.equal("no changesets yet");
    });

    it("finds a hidden branch and re-checks its head through the hidden query too", async () => {
      shell.answer = (command, args) => {
        if (args[0] === "review") {
          return HIDDEN_BRANCH_REVIEW_XML;
        }
        if (args[0] === "branch") {
          return args[1] === `where id = ${HIDDEN_BRANCH_ID} and hidden = 'true'`
            ? branchRowXml(HIDDEN_BRANCH_ID, HIDDEN_BRANCH_NAME, 3521)
            : EMPTY_QUERY;
        }
        return scenarioAnswer(command, args);
      };
      const files = await service.loadFiles((await service.review(10071))!);
      expect(files.branchDeleted).to.equal(false);
      expect(files.branch).to.include({ hidden: true, name: HIDDEN_BRANCH_NAME });
      expect(files.head).to.equal(3521);
      expect(files.final.files).to.have.length(PLAIN_ROW_COUNT);
      expect(shell.queries("branch")).to.deep.equal([
        `where id = ${HIDDEN_BRANCH_ID}`,
        `where id = ${HIDDEN_BRANCH_ID} and hidden = 'true'`,
        `where id = ${HIDDEN_BRANCH_ID}`,
        `where id = ${HIDDEN_BRANCH_ID} and hidden = 'true'`,
      ]);
    });

    it("reports a deleted branch only when both branch queries are empty", async () => {
      shell.answer = (command, args) => args[0] === "branch" ? EMPTY_QUERY : scenarioAnswer(command, args);
      const files = await service.loadFiles(await scenarioReview());
      expect(files.branchDeleted).to.equal(true);
      expect(files.final.files).to.deep.equal([]);
      expect(files.head).to.equal(-1);
      expect(files.final.label).to.equal("branch deleted");
      expect(shell.queries("branch")).to.have.length(2);
      expect(shell.calls.some(call => call.command === "diff")).to.equal(false);
    });

    it("retries when the branch moves during loading, and gives up after three attempts", async () => {
      let reads = 0;
      shell.answer = (command, args) =>
        args[0] === "branch" ? branchXml(++reads === 1 ? 2 : 3) : defaultAnswer(command, args);
      service = new ReviewService("wk", "/unused", channel, config, shell);
      const files = await service.loadFiles((await service.review(5))!);
      expect(files.head).to.equal(3);
      expect(shell.calls.filter(call => call.command === "diff")).to.have.length(2);

      shell.calls = [];
      shell.answer = (command, args) => args[0] === "branch" ? branchXml(++reads) : defaultAnswer(command, args);
      expect((await failure(service.loadFiles((await service.review(5))!))).message).to.contain("branch changed");
      expect(shell.calls.filter(call => call.command === "diff")).to.have.length(3);
    });

    it("gives every load a new final comparison id", async () => {
      const review = await scenarioReview();
      const first = await service.loadFiles(review);
      const second = await service.loadFiles(review);
      expect(second.final.id).not.to.equal(first.final.id);
      expect(first.final.id.startsWith(`${BRANCH_REVIEW_ID}:final:${HEAD}:`)).to.equal(true);
    });

    it("stops between cm calls once a newer load took over", async () => {
      let current = true;
      shell.answer = (command, args) => {
        if (args[0] === "merge") {
          current = false;
        }
        return scenarioAnswer(command, args);
      };
      const error = await failure(service.loadFiles(await scenarioReview(), () => current));
      expect(isReviewLoadCancelled(error)).to.equal(true);
      expect(shell.calls.some(call => call.command === "diff")).to.equal(false);
    });

    it("loads a changeset review whose changeset sits on a hidden branch", async () => {
      const review = await scenarioReview(CHANGESET_REVIEW_ID);
      const files = await service.loadFiles(review);
      expect(files.branch).to.equal(undefined);
      expect(files).to.include({ base: 3195, branchDeleted: false, head: 3203 });
      expect(files.final.label).to.equal("cs:3195 ↔ cs:3203");
      expect(files.final.files).to.have.length(2);
      expect(shell.queries("changeset")).to.deep.equal(["where changesetid=3203 and ignorehidden = 'true'"]);
      expect(shell.calls.find(call => call.command === "diff")?.args[0]).to.equal("cs:3203");
    });
  });

  describe("changesets stage", () => {
    it("lists the branch up to the pinned head, hidden branches included, with merges flagged", async () => {
      const review = await scenarioReview();
      const files = await service.loadFiles(review);
      shell.calls = [];
      const changesets = await service.loadChangesets(review, files);
      expect(shell.queries("changeset")).to.deep.equal([
        `where branch='${BRANCH_NAME}' and changesetid < ${HEAD + 1} and ignorehidden = 'true' ` +
        "order by changesetid desc limit 50",
      ]);
      expect(changesets.hasMore).to.equal(false);
      expect(changesets.items.map(item => [ item.id, item.isMerge, item.mergeSourceBranch ])).to.deep.equal([
        [ HEAD, false, undefined ],
        [ 3699, true, "/main" ],
        [ 3477, true, "/main" ],
      ]);
    });

    it("pages within the pinned head without changing the loaded page", async () => {
      shell.answer = (command, args) => {
        if (args[0] === "changeset" && !args[1].includes("asc")) {
          return args[1].includes("changesetid < 2031") ? changesetsXml(1, 2030) : changesetsXml(50, 2080);
        }
        return args[0] === "branch" && !args[1].includes("hidden") ? branchXml(2080) : defaultAnswer(command, args);
      };
      service = new ReviewService("wk", "/unused", channel, config, shell);
      const review = (await service.review(5))!;
      const files = await service.loadFiles(review);
      const first = await service.loadChangesets(review, files);
      expect(first.hasMore).to.equal(true);
      const more = await service.moreChangesets(files, first);
      expect(first.items).to.have.length(50);
      expect(more.items).to.have.length(51);
      expect(more.hasMore).to.equal(false);
      expect(shell.queries("changeset").pop()).to.contain("changesetid < 2031 and ignorehidden = 'true'");
    });

    it("reads the changeset of a changeset review with ignorehidden", async () => {
      const review = await scenarioReview(CHANGESET_REVIEW_ID);
      const files = await service.loadFiles(review);
      const changesets = await service.loadChangesets(review, files);
      expect(changesets.items.map(item => item.branch)).to.deep.equal(["/main/feature_TestGenerator"]);
      expect(shell.queries("changeset")).to.have.length(1);
    });

    it("diffs one changeset lazily, labels both sides and caches it per final comparison", async () => {
      const review = await scenarioReview();
      const files = await service.loadFiles(review);
      const changesets = await service.loadChangesets(review, files);
      shell.calls = [];
      const comparison = await service.changesetComparison(files, changesets.items[0]);
      await service.changesetComparison(files, changesets.items[0]);
      expect(comparison).to.include({ headChangesetId: HEAD, kind: "changeset", label: `cs:3700 ↔ cs:${HEAD}` });
      expect(comparison.id).to.equal(`${files.final.id}:cs:${HEAD}`);
      expect(shell.calls.filter(call => call.command === "diff")).to.have.length(1);
      const foreign = { ...changesets.items[0], branch: "/main" };
      expect((await failure(service.changesetComparison(files, foreign))).message).to.contain("not part");
    });
  });

  describe("discussions stage", () => {
    it("groups every comment row, timeline included, and names server paths", async () => {
      const review = await scenarioReview();
      const files = await service.loadFiles(review);
      const discussions = await service.loadDiscussions(review, files);
      const byId = new Map(discussions.threads.map(thread => [ thread.id, thread ]));
      expect(Array.from(byId.keys())).to.deep.equal(
        [ 12907, 12915, 12918, 12919, 12926, 12931, 12961, 12981 ]);
      // Exact revision hit: the diff row's own path.
      expect(byId.get(12907)!.path).to.equal(ANALYTICS_PATH);
      // Not in the final diff: the local path minus the workspace root.
      expect(byId.get(12915)!.path).to.equal("/Assets/Code/Core/SaveSystem.cs");
      expect(byId.get(12919)!.path).to.equal(LAP_TIMER_PATH);
      // A base-side revision names the row's left path.
      expect(byId.get(12961)!.path).to.equal(LAP_TIMER_PATH);
      expect(byId.get(12981)!.path).to.equal(undefined);
      expect(byId.get(12926)!.path).to.equal(undefined);
      const status = byId.get(12931)!;
      expect(status).to.include({ kind: "status" });
      expect(status.comments.map(item => item.text)).to.deep.equal([
        "LGTM, only a few small questions, none blocking.", "Both points addressed. Cheers!",
      ]);
      expect(discussions.timeline.map(event => event.kind)).to.deep.equal(
        [ "renamed", "reviewRequested", "reviewRequested", "status", "status" ]);
      expect(discussions.reviewers).to.deep.equal([ME]);
      expect(discussions.message).to.equal(undefined);
      expect(shell.queries("changereviewcomment")).to.deep.equal([`where reviewid = ${BRANCH_REVIEW_ID}`]);
      expect(shell.queries("revision")).to.have.length(1);
    });

    it("falls back to local paths when the files stage is not loaded", async () => {
      const discussions = await service.loadDiscussions(await scenarioReview());
      expect(discussions.threads.find(thread => thread.id === 12907)!.path).to.equal(ANALYTICS_PATH);
    });

    it("keeps discussions when revision metadata cannot be read", async () => {
      shell.answer = (command, args) => {
        if (args[0] === "revision") {
          throw new Error("Access denied");
        }
        return scenarioAnswer(command, args);
      };
      const discussions = await service.loadDiscussions(await scenarioReview());
      expect(discussions.threads).to.have.length(8);
      expect(discussions.message).to.contain("locations");
    });

    it("keeps files browsable on clients without comment queries, and does not hide other failures", async () => {
      shell.answer = (command, args) => {
        if (args[0] === "changereviewcomment") {
          throw new Error("Unknown object changereviewcomment");
        }
        return scenarioAnswer(command, args);
      };
      const review = await scenarioReview();
      expect((await service.loadDiscussions(review)).message).to.contain("does not support");
      shell.answer = (command, args) => {
        if (args[0] === "changereviewcomment") {
          throw new Error("Connection lost");
        }
        return scenarioAnswer(command, args);
      };
      expect((await failure(service.loadDiscussions(review))).message).to.contain("Connection lost");
    });
  });

  describe("queue", () => {
    const requestRows: Array<[number, string]> = [
      [ 2242, `[requested-review-from]${ME}` ],
      [ 2243, `[requested-review-from-${ME}]` ],
      [ 2243, `[removed-requested-review-from]${ME}` ],
      [ 2244, `[requested-review-from]${ME}` ],
      [ 2244, `[removed-requested-review-from]${ME}` ],
      [ 2244, `[re-requested-review-from]${ME}` ],
      [ 2081, `[requested-review-from]${ME}` ],
      [ 2084, `[requested-review-from]${ME}` ],
      [ 2245, `[requested-review-from]${ME}` ],
    ];
    const requests = commentsXml(requestRows.map(([ reviewId, text ], index) => comment({
      changesetId: -1,
      date: `2026-09-${10 + index}T10:00:00+01:00`,
      id: 2401 + index,
      location: -1,
      owner: AUTHOR,
      reviewId,
      revisionId: -1,
      text,
      type: "timeline",
    })));
    const answer = (command: string, args: string[]): string => {
      const where = args[1] ?? "";
      if (args[0] === "review" && where.startsWith("where assignee = 'me'")) {
        return reviewsXml([
          { assignee: ME, date: "2026-09-20T10:00:00+01:00", id: 2081 },
          { assignee: ME, id: 2082, status: "Rework required" },
          { assignee: ME, date: "2026-09-19T10:00:00+01:00", id: 2083, owner: ME },
        ]);
      }
      if (args[0] === "review" && where.startsWith("where owner = 'me'")) {
        return reviewsXml([
          { assignee: ME, date: "2026-09-19T10:00:00+01:00", id: 2083, owner: ME },
          { id: 2084, owner: ME, status: "Rework required" },
          { assignee: AUTHOR, id: 2085, owner: ME },
        ]);
      }
      if (args[0] === "review" && where.startsWith("where (id = ")) {
        // Reviewed ones (2245) are left out by the server; my own (2084) is dropped by the service.
        return reviewsXml([
          { date: "2026-09-22T09:00:00+01:00", id: 2244 },
          { date: "2026-09-18T10:00:00+01:00", id: 2242 },
          { id: 2084, owner: ME, status: "Rework required" },
        ]);
      }
      if (args[0] === "changereviewcomment") {
        return requests;
      }
      return scenarioAnswer(command, args);
    };

    it("finds Needs My Review from assignment and timeline requests, never listing my own reviews", async () => {
      shell.answer = answer;
      const needs = await service.needsMyReview();
      expect(needs.map(review => review.id)).to.deep.equal([ 2244, 2081, 2242 ]);
      // It never uses the query for my own reviews, so either part can fail on its own.
      expect(shell.queries("review")).to.deep.equal([
        "where assignee = 'me' and status != 'Reviewed' order by date desc limit 100",
        "where (id = 2242 or id = 2244 or id = 2084 or id = 2245) and status != 'Reviewed' order by date desc",
      ]);
      expect(shell.queries("changereviewcomment")).to.deep.equal([
        `where type = 'timeline' and comment like '%review-from%${ME}%'`,
      ]);
    });

    it("groups my own open reviews by status from one query", async () => {
      shell.answer = answer;
      const owned = await service.ownedQueue();
      expect(owned.reworkRequested.map(review => review.id)).to.deep.equal([2084]);
      expect(owned.waitingForReviewers.map(review => review.id)).to.deep.equal([ 2083, 2085 ]);
      expect(shell.queries("review")).to.deep.equal([
        "where owner = 'me' and status != 'Reviewed' order by date desc limit 100",
      ]);
      expect(shell.calls.some(call => call.command === "whoami")).to.equal(false);
    });

    it("asks cm who the user is once", async () => {
      shell.answer = answer;
      await service.needsMyReview();
      await service.needsMyReview();
      expect(shell.calls.filter(call => call.command === "whoami")).to.have.length(1);
      expect(await service.whoami()).to.equal(ME);
    });

    it("skips the id query when every requested review is already known", async () => {
      shell.answer = (command, args) => args[0] === "changereviewcomment" ? EMPTY_QUERY : answer(command, args);
      await service.needsMyReview();
      expect(shell.queries("review")).to.have.length(1);
    });
  });

  describe("fileForRevision", () => {
    it("finds exact hits on either side without calling cm", async () => {
      const files = (await service.loadFiles(await scenarioReview())).final.files;
      shell.calls = [];
      const right = await service.fileForRevision(files, revision(12804));
      expect(right).to.deep.include({ exact: "right" });
      expect(right!.file.path).to.equal(LAP_TIMER_PATH);
      const left = await service.fileForRevision(files, revision(10851));
      expect(left).to.deep.include({ exact: "left" });
      expect(left!.file.path).to.equal(LAP_TIMER_PATH);
      const deleted = await service.fileForRevision(files, { ...revision(12804), id: 11911 });
      expect(deleted).to.deep.include({ exact: "left" });
      expect(deleted!.file.path).to.equal(DELETED_PATH);
      expect(shell.calls).to.deep.equal([]);
    });

    it("matches another revision of the item with one itemid query, never a scan", async () => {
      const files = (await service.loadFiles(await scenarioReview())).final.files;
      shell.calls = [];
      const hit = await service.fileForRevision(files, revision(12671));
      expect(hit).to.deep.include({ exact: undefined });
      expect(hit!.file.path).to.equal(LAP_TIMER_PATH);
      expect(shell.queries("revision")).to.deep.equal([`where itemid = 6721 on repository '${REPOSITORY}'`]);
      await service.fileForRevision(files, revision(12671));
      expect(shell.queries("revision")).to.have.length(1);
    });

    it("asks again after a cached miss and returns undefined for items outside the diff", async () => {
      const files = (await service.loadFiles(await scenarioReview())).final.files;
      shell.calls = [];
      expect(await service.fileForRevision(files, revision(12771))).to.equal(undefined);
      expect(await service.fileForRevision(files, revision(12771))).to.equal(undefined);
      expect(shell.queries("revision")).to.have.length(2);
      expect(shell.queries("revision").every(where => where.startsWith("where itemid = "))).to.equal(true);
    });

    it("does not match a row of another repository", async () => {
      const files = (await service.loadFiles(await scenarioReview())).final.files;
      const other = { ...revision(12804), repository: "Shared/Libs@acme-studio@unity" };
      shell.answer = () => EMPTY_QUERY;
      expect(await service.fileForRevision(files, other)).to.equal(undefined);
    });
  });

  describe("server paths", () => {
    it("strips the workspace root from local paths", () => {
      expect(service.serverPath(`${WORKSPACE_ROOT}/Assets/Code/A.cs`)).to.equal("/Assets/Code/A.cs");
      expect(service.serverPath("/Volumes/Elsewhere/A.cs")).to.equal(undefined);
      expect(service.serverPath(`${WORKSPACE_ROOT}Other/A.cs`)).to.equal(undefined);
      expect(service.serverPath(WORKSPACE_ROOT)).to.equal(undefined);
    });

    it("handles Windows paths, case-insensitively only where the platform is", () => {
      expect(toServerPath("C:\\ws\\root", "C:\\ws\\root\\Code\\Test.cs", false)).to.equal("/Code/Test.cs");
      expect(toServerPath("C:\\ws\\root\\", "c:\\WS\\Root\\Code\\Test.cs", true)).to.equal("/Code/Test.cs");
      expect(toServerPath("C:\\ws\\root", "c:\\WS\\Root\\Code\\Test.cs", false)).to.equal(undefined);
    });
  });

  describe("revision content", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(path.join(os.tmpdir(), "plastic-review-root-"));
    });
    afterEach(() => rmSync(root, { force: true, recursive: true }));

    it("caches revisions under the workspace root, shared with History", async () => {
      shell.answer = (command, args) => {
        if (command === "getfile") {
          writeFileSync(args[1].replace(/^--file=/, ""), "\ufeffline one\r\nline two");
          return "";
        }
        return scenarioAnswer(command, args);
      };
      service = new ReviewService("wk", root, channel, config, shell);
      expect(await service.text(12804, REPOSITORY, LAP_TIMER_PATH)).to.equal("line one\r\nline two");
      expect(await service.text(12804, REPOSITORY, LAP_TIMER_PATH)).to.equal("line one\r\nline two");
      const getfile = shell.calls.filter(call => call.command === "getfile");
      expect(getfile).to.have.length(1);
      expect(getfile[0].args[0]).to.equal(`revid:12804@rep:${REPOSITORY}`);
      // As the service builds it: `Uri.fsPath` lowercases a Windows drive letter.
      const cacheDir = Uri.file(path.join(root, ".plastic", "fileCache", "revisions")).fsPath;
      expect(getfile[0].args[1].startsWith(`--file=${cacheDir}${path.sep}`)).to.equal(true);
      expect(existsSync(cacheDir)).to.equal(true);
      expect(readdirSync(cacheDir)).to.have.length(1);
    });

    it("refuses a revision without a repository and returns nothing for a missing side", async () => {
      expect((await failure(service.text(12804, "", LAP_TIMER_PATH))).message).to.contain("repository");
      expect(await service.text(-1, "", ADDED_PATH)).to.equal("");
      expect(shell.calls).to.deep.equal([]);
    });
  });

  describe("updates and status", () => {
    const loaded = async () => {
      const review = await scenarioReview();
      const files = await service.loadFiles(review);
      const discussions = await service.loadDiscussions(review, files);
      return { discussions, files, review };
    };

    it("reports nothing when nothing changed, including a hidden branch's head", async () => {
      const { discussions, files, review } = await loaded();
      shell.calls = [];
      expect(await service.checkUpdates(review, files, discussions)).to.equal(undefined);
      expect(shell.calls.map(call => call.args[0])).to.deep.equal([ "review", "branch", "changereviewcomment" ]);

      shell.answer = (command, args) => {
        if (args[0] === "branch") {
          return args[1].includes("hidden") ? branchRowXml(BRANCH_ID, BRANCH_NAME, HEAD) : EMPTY_QUERY;
        }
        return scenarioAnswer(command, args);
      };
      expect(await service.checkUpdates(review, files, discussions)).to.equal(undefined);
    });

    it("counts head, status, new, edited and removed comments without touching the loaded stages", async () => {
      const { discussions, files, review } = await loaded();
      const edited = SCENARIO_COMMENTS
        .filter(row => row.id !== 12926)
        .map(row => row.id === 12907 ? { ...row, text: "Edited" } : row)
        .concat([{ ...SCENARIO_COMMENTS[3], id: 13001, text: "One more thing" }]);
      shell.answer = (command, args) => {
        if (args[0] === "branch") {
          return args[1].includes("hidden") ? EMPTY_QUERY : branchRowXml(BRANCH_ID, BRANCH_NAME, 3733);
        }
        if (args[0] === "review") {
          return reviewsXml([{ assignee: ME, id: BRANCH_REVIEW_ID, status: "Rework required" }]);
        }
        return args[0] === "changereviewcomment" ? commentsXml(edited) : scenarioAnswer(command, args);
      };
      expect(await service.checkUpdates(review, files, discussions)).to.deep.equal({
        newComments: 2, newHead: 3733, removedComments: 1, status: "Rework required",
      });
      expect(discussions.threads.find(thread => thread.id === 12907)!.comments[0].text).not.to.equal("Edited");
      expect(files.head).to.equal(HEAD);
    });

    it("ignores timeline rows without text, such as the user's own status change", async () => {
      const { discussions, files, review } = await loaded();
      const rows = SCENARIO_COMMENTS.concat([{ ...SCENARIO_COMMENTS[11], id: 13002, text: "[status-reviewed]" }]);
      shell.answer = (command, args) =>
        args[0] === "changereviewcomment" ? commentsXml(rows) : scenarioAnswer(command, args);
      expect(await service.checkUpdates(review, files, discussions)).to.equal(undefined);
    });

    it("writes the status, then reads the review back", async () => {
      shell.answer = (command, args) => args[0] === "review" && shell.calls.some(call => call.command === "codereview")
        ? reviewsXml([{ assignee: ME, id: BRANCH_REVIEW_ID, status: "Reviewed" }])
        : scenarioAnswer(command, args);
      const updated = await service.setStatus(BRANCH_REVIEW_ID, "Reviewed");
      expect(updated.status).to.equal("Reviewed");
      expect(shell.calls.map(call => call.command)).to.deep.equal([ "codereview", "find" ]);
      expect(shell.calls[0].args).to.deep.equal([ "-e", String(BRANCH_REVIEW_ID), "--status=Reviewed" ]);
      expect(shell.queries("review")).to.deep.equal([`where id = ${BRANCH_REVIEW_ID}`]);
    });
  });

  describe("simple reviews", () => {
    beforeEach(() => {
      shell.answer = defaultAnswer;
      service = new ReviewService("wk", "/unused", channel, config, shell);
    });

    it("loads without a write and keeps discussion text as written", async () => {
      const review = (await service.review(5))!;
      const files = await service.loadFiles(review);
      const discussions = await service.loadDiscussions(review, files);
      expect(files.head).to.equal(2);
      expect(discussions.threads[0].path).to.equal("/Code/Test.cs");
      expect(discussions.threads[0].comments[0].text).to.equal("  first\nsecond & third  ");
      expect(shell.calls.every(call => [ "find", "diff" ].includes(call.command))).to.equal(true);
    });

    it("supports a fixed changeset review", async () => {
      const changesetReview = REVIEW_XML.replace("Branch", "Changeset").replace("id:8", "2");
      shell.answer = (command, args) => args[0] === "review" ? changesetReview : defaultAnswer(command, args);
      const files = await service.loadFiles((await service.review(5))!);
      expect(files.branch).to.equal(undefined);
      expect(files.final.label).to.equal("cs:1 ↔ cs:2");
      expect(shell.calls.find(call => call.command === "diff")?.args[0]).to.equal("cs:2");
    });

    it("rejects unsupported target types", async () => {
      shell.answer = (command, args) =>
        args[0] === "review" ? REVIEW_XML.replace("Branch", "Label") : defaultAnswer(command, args);
      expect((await failure(service.loadFiles((await service.review(5))!))).message).to.contain("not supported");
    });

    it("validates review targets instead of interpolating arbitrary specs", () => {
      expect(targetNumber("id:8")).to.equal(8);
      expect(targetNumber("cs:2")).to.equal(2);
      expect(() => targetNumber("8 or id=1")).to.throw();
    });

    it("does not cache a failed revision lookup", async () => {
      shell.answer = () => {
        throw new Error("temporarily unavailable");
      };
      await failure(service.revision(11));
      shell.answer = defaultAnswer;
      expect((await service.revision(11)).id).to.equal(11);
    });

    it("detects an edited comment", async () => {
      const review = (await service.review(5))!;
      const discussions = await service.loadDiscussions(review);
      shell.answer = (command, args) =>
        args[0] === "changereviewcomment" ? COMMENT_XML.replace("first", "edited") : defaultAnswer(command, args);
      expect(await service.checkUpdates(review, undefined, discussions)).to.deep.equal({
        newComments: 1, removedComments: 0,
      });
      expect(discussions.threads[0].comments[0].text).to.contain("first");
    });

    it("refuses to work after it was disposed", async () => {
      service.dispose();
      expect((await failure(service.review(5))).message).to.contain("stopped");
    });
  });

  it("reads revisions of the scenario from their local paths", async () => {
    await service.ready();
    const row = await service.revision(12771);
    expect(row).to.include({ branch: BRANCH_NAME, itemId: 5941, repository: REPOSITORY });
    expect(row.path).to.equal(`${WORKSPACE_ROOT}/Assets/Code/Core/SaveSystem.cs`);
    expect(revisionsXml([])).to.contain("PLASTICQUERY");
  });
});
