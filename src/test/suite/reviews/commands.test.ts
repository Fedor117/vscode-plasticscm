import {
  BRANCH_NAME,
  branchRowXml,
  CLEAN_DIFF_OUTPUT,
  COMMENT_XML,
  defaultAnswer,
  EMPTY_QUERY,
  HIDDEN_BRANCH_ID,
  HIDDEN_BRANCH_NAME,
  LAP_TIMER_PATH,
  MERGES_XML,
  PLAIN_DIFF_OUTPUT,
  REPOSITORY,
  REVIEW_XML,
  ReviewShell,
  REVISION_XML,
  REVISIONS,
  revisionsXml,
  WORKSPACE_ROOT,
} from "./fixtures";
import {
  commentsUnsupported,
  parseComment,
  parseReview,
  parseRevision,
  queryParser,
  queryString,
  ReviewCommands,
} from "../../../reviews/commands";
import { DiffChangesetParser } from "../../../cm/commands/diffChangeset/diffChangesetParser";
import { expect } from "chai";
import { ICmParser } from "../../../cm/shell";

async function parse<T>(output: string, parser: ICmParser<T>): Promise<T> {
  output.split("\n").forEach(line => parser.readLineOut(line));
  const result = await parser.parse();
  expect(parser.getError()).to.equal(undefined);
  return result!;
}

async function failure(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected a rejection");
}

describe("Review CLI commands", () => {
  let shell: ReviewShell;
  let api: ReviewCommands;
  beforeEach(() => {
    shell = new ReviewShell();
    shell.answer = defaultAnswer;
    api = new ReviewCommands(shell);
  });

  describe("parsing", () => {
    it("parses review metadata and human status", async () => {
      const rows = await parse(REVIEW_XML, queryParser("review", parseReview));
      expect(rows[0]).to.include({
        id: 5,
        status: "Under review",
        target: "id:8",
        targetType: "branch",
        title: "Review & discuss",
      });
    });

    it("retains multiline text, whitespace, zero-based anchors, and parent IDs", async () => {
      const rows = await parse(COMMENT_XML, queryParser("changereviewcomment", parseComment));
      expect(rows[0]).to.include({ location: 3, parentId: -1, revisionId: 11, text: "  first\nsecond & third  " });
    });

    it("resolves item identity, qualified repository and branch", async () => {
      const rows = await parse(REVISION_XML, queryParser("revision", parseRevision));
      expect(rows[0]).to.include({
        branch: "/main/task", itemId: 90, path: "/Code/Test.cs", repository: "repo@org@cloud",
      });
    });

    it("keeps the local absolute path cm prints for a revision", async () => {
      const rows = await parse(revisionsXml(REVISIONS.slice(0, 1)), queryParser("revision", parseRevision));
      expect(rows[0]).to.include({
        changesetId: 3700, id: 12804, parentId: 12671, path: `${WORKSPACE_ROOT}${LAP_TIMER_PATH}`,
        repository: REPOSITORY,
      });
    });

    it("accepts empty XML results", async () => {
      expect(await parse("<PLASTICQUERY></PLASTICQUERY>", queryParser("review", parseReview))).to.deep.equal([]);
      expect(await parse("<PLASTICQUERY />", queryParser("review", parseReview))).to.deep.equal([]);
      expect(await parse(EMPTY_QUERY, queryParser("review", parseReview))).to.deep.equal([]);
    });

    it("rejects errors or truncated output masquerading as an empty result", async () => {
      for (const output of [ "Query error", "<PLASTICQUERY><REVIEW>" ]) {
        const parser = queryParser("review", parseReview);
        parser.readLineOut(output);
        expect(await parser.parse()).to.equal(undefined);
        expect(parser.getError()).to.be.instanceOf(Error);
      }
    });

    it("reads the --clean diff past cm's progress preamble, with the plain diff's revisions", async () => {
      const clean = await parse(CLEAN_DIFF_OUTPUT, new DiffChangesetParser());
      const plain = await parse(PLAIN_DIFF_OUTPUT, new DiffChangesetParser());
      expect(clean).to.have.length(5);
      const plainRows = new Map(plain.map(row => [ row.path, row ]));
      for (const row of clean) {
        expect(plainRows.get(row.path)).to.deep.equal(row);
      }
    });
  });

  describe("queries", () => {
    it("lists reviews with fixed where-clauses resolved by the server", async () => {
      await api.list("assignedOpen");
      await api.list("ownedOpen");
      await api.list("allOpen", 50);
      await api.list("all");
      await api.list("all", 100);
      await api.list("find");
      expect(shell.queries("review")).to.deep.equal([
        "where assignee = 'me' and status != 'Reviewed' order by date desc limit 100",
        "where owner = 'me' and status != 'Reviewed' order by date desc limit 100",
        "where status != 'Reviewed' order by date desc limit 50 offset 50",
        "where id > 0 order by date desc limit 50 offset 0",
        "where id > 0 order by date desc limit 50 offset 100",
        "where id > 0 order by date desc limit 2000",
      ]);
      expect(shell.calls[0].args.slice(2)).to.deep.equal([ "--xml", "--nototal", "--encoding=utf-8" ]);
      expect(await failure(() => api.list("allOpen", 1.5))).to.contain("integer");
    });

    it("reads reviews by id in pages, open ones only when asked", async () => {
      const ids = Array.from({ length: 51 }, (_, index) => index + 1);
      await api.reviews(ids.concat([1]), true);
      await api.reviews([7], false);
      const queries = shell.queries("review");
      expect(queries).to.have.length(3);
      expect(queries[0].startsWith("where (id = 1 or id = 2 or ")).to.equal(true);
      expect(queries[0].endsWith("id = 50) and status != 'Reviewed' order by date desc")).to.equal(true);
      expect(queries[1]).to.equal("where (id = 51) and status != 'Reviewed' order by date desc");
      expect(queries[2]).to.equal("where (id = 7) order by date desc");
    });

    it("reads every comment row of a review, timeline included", async () => {
      await api.comments(5);
      expect(shell.queries("changereviewcomment")).to.deep.equal(["where reviewid = 5"]);
    });

    it("finds review requests for a user through a validated like pattern", async () => {
      await api.reviewRequests("alex.reviewer@example.com");
      expect(shell.queries("changereviewcomment")).to.deep.equal([
        "where type = 'timeline' and comment like '%review-from%alex.reviewer@example.com%'",
      ]);
      expect(await failure(() => api.reviewRequests("x' or '1' = '1"))).to.contain("quotes");
      expect(shell.calls).to.have.length(1);
    });

    it("looks up a branch with the plain query, then the hidden one", async () => {
      shell.answer = (_command, args) => args[1].includes("hidden")
        ? branchRowXml(HIDDEN_BRANCH_ID, HIDDEN_BRANCH_NAME, 3521)
        : EMPTY_QUERY;
      expect(await api.branch(HIDDEN_BRANCH_ID)).to.deep.equal({
        headChangesetId: 3521, hidden: true, id: HIDDEN_BRANCH_ID, name: HIDDEN_BRANCH_NAME, parent: "/main",
      });
      expect(shell.queries("branch")).to.deep.equal([
        `where id = ${HIDDEN_BRANCH_ID}`,
        `where id = ${HIDDEN_BRANCH_ID} and hidden = 'true'`,
      ]);
    });

    it("stops at the plain branch query when it finds the branch, and reports a deleted one", async () => {
      expect(await api.branch(8)).to.include({ hidden: false, name: "/main/task" });
      expect(shell.queries("branch")).to.have.length(1);
      shell.answer = () => EMPTY_QUERY;
      expect(await api.branch(9)).to.equal(undefined);
      expect(shell.queries("branch")).to.have.length(3);
    });

    it("names branches by id in pages, asking the hidden query only for the ones the plain query missed", async () => {
      shell.answer = (_command, args) => {
        const where = args[1];
        if (where.startsWith("where (id = 2442 ") && !where.includes("hidden")) {
          return branchRowXml(2442, BRANCH_NAME, 3715);
        }
        if (where.includes("id = 2443 ") && where.includes("hidden")) {
          return branchRowXml(2443, HIDDEN_BRANCH_NAME, 3521);
        }
        // A row it did not ask for is not taken for a name.
        return where === "where (id = 2492)" ? branchRowXml(2821, "/main/stray", 1) : EMPTY_QUERY;
      };
      const ids = Array.from({ length: 51 }, (_, index) => 2442 + index);
      const names = await api.branchNames(ids.concat([2442]));
      expect(Array.from(names)).to.deep.equal([[ 2442, BRANCH_NAME ], [ 2443, HIDDEN_BRANCH_NAME ]]);
      const queries = shell.queries("branch");
      expect(queries).to.have.length(4);
      expect(queries[0].startsWith("where (id = 2442 or id = 2443 or ")).to.equal(true);
      expect(queries[0].endsWith(" or id = 2491)")).to.equal(true);
      expect(queries[1].startsWith("where (id = 2443 or id = 2444 or ")).to.equal(true);
      expect(queries[1].endsWith(" or id = 2491) and hidden = 'true'")).to.equal(true);
      expect(queries.slice(2)).to.deep.equal([ "where (id = 2492)", "where (id = 2492) and hidden = 'true'" ]);
      expect(await failure(() => api.branchNames([1.5]))).to.contain("integer");
      expect(shell.calls).to.have.length(4);
    });

    it("reads revisions by id and by item, qualified by repository", async () => {
      await api.revision(11, REPOSITORY);
      await api.revisions([ 11, 12, 11 ]);
      await api.itemRevisionIds(6721, REPOSITORY);
      await api.itemRevisionIds(6721);
      expect(shell.queries("revision")).to.deep.equal([
        `where id = 11 on repository '${REPOSITORY}'`,
        "where (id = 11 or id = 12)",
        `where itemid = 6721 on repository '${REPOSITORY}'`,
        "where itemid = 6721",
      ]);
      expect(await failure(() => api.itemRevisionIds(1, "repo' or '1"))).to.contain("quotes");
    });

    it("asks for merges into the branch up to the head, with cm's encoded branch spec", async () => {
      shell.answer = () => MERGES_XML;
      const merges = await api.merges("/main/my branch", 3715);
      expect(shell.queries("merge")).to.deep.equal([
        "where dstbranch = 'br:/main/my%20branch' and dstchangeset <= 3715",
      ]);
      expect(merges.map(link => [ link.sourceChangesetId, link.sourceBranch, link.destinationChangesetId ]))
        .to.deep.equal([[ 3476, "/main", 3477 ], [ 3690, "/main", 3699 ]]);
      expect(await failure(() => Promise.resolve().then(() => api.merges("/main/it's", 1)))).to.contain("quotes");
    });

    it("includes changesets of hidden branches in every review changeset query", async () => {
      await api.changesets(BRANCH_NAME, 3716);
      await api.changeset(3203);
      await api.firstChangeset(BRANCH_NAME);
      expect(shell.queries("changeset")).to.deep.equal([
        `where branch='${BRANCH_NAME}' and changesetid < 3716 and ignorehidden = 'true' ` +
        "order by changesetid desc limit 50",
        "where changesetid=3203 and ignorehidden = 'true'",
        `where branch = '${BRANCH_NAME}' and ignorehidden = 'true' order by changesetid asc limit 1`,
      ]);
    });

    it("reads the cm user", async () => {
      shell.answer = () => "\nalex.reviewer@example.com\n";
      expect(await api.whoami()).to.equal("alex.reviewer@example.com");
      expect(shell.calls[0]).to.deep.equal({ args: [], command: "whoami" });
      shell.answer = () => "";
      expect(await failure(() => api.whoami())).to.contain("did not name a user");
    });
  });

  describe("diffs", () => {
    it("uses the formatted plain branch diff, without integration or clean", async () => {
      const files = await api.diff("br:/main/task");
      expect(files[0]).to.include({ baseRevisionId: 10, parentRevisionId: 9, revisionId: 11 });
      expect(shell.calls[0].args[0]).to.equal("br:/main/task");
      expect(shell.calls[0].args.some(arg => arg.startsWith("--format="))).to.equal(true);
      expect(shell.calls[0].args).to.include("--repositorypaths");
      expect(shell.calls[0].args).not.to.include("--integration");
      expect(shell.calls[0].args).not.to.include("--clean");
    });

    it("adds --clean only to branch diffs", async () => {
      await api.diff("br:/main/task", { clean: true });
      expect(shell.calls[0].args[shell.calls[0].args.length - 1]).to.equal("--clean");
      expect(() => api.diff("cs:2", { clean: true })).to.throw("branch");
      expect(() => api.diff("br:/main/x\" --help")).to.throw("Invalid");
      expect(() => api.diff("lb:BL001")).to.throw("Invalid");
    });
  });

  describe("status", () => {
    it("restricts status writes to the explicit review and propagates failures", async () => {
      await api.setStatus(5, "Rework required");
      expect(shell.calls[0]).to.deep.equal({ args: [ "-e", "5", "--status=Rework required" ], command: "codereview" });
      shell.answer = () => {
        throw new Error("Access denied");
      };
      expect(await failure(() => api.setStatus(5, "Reviewed"))).to.contain("Access denied");
      expect(await failure(() => api.setStatus(5, "Deleted" as never))).to.contain("Invalid review status");
    });
  });

  it("does not mistake network or permission errors for unsupported comments", () => {
    expect(commentsUnsupported(new Error("Unknown object changereviewcomment"))).to.equal(true);
    expect(commentsUnsupported(new Error("Access denied"))).to.equal(false);
    expect(commentsUnsupported(new Error("Connection timed out"))).to.equal(false);
    expect(() => queryString("x' or id=1")).to.throw();
    expect(queryString("/main/task")).to.equal("'/main/task'");
  });
});
