import { CHANGESET_REVIEW_ID, file } from "./fixtures";
import { expectHandlerLinksOpen, expectWellFormed, links } from "./overviewFixtures";
import { IReviewLink, parseReviewLink, reviewLinkUri } from "../../../reviews/reviewLinks";
import { IScenario, loadScenario, NOW, readyReview } from "./viewFixtures";
import { expect } from "chai";
import { fileKey } from "../../../reviews/models";
import { IActiveReview } from "../../../reviews/sessionTypes";
import { renderOverview } from "../../../reviews/reviewOverview";
import { Uri } from "vscode";

const BASE = { authority: "plastic-scm.plastic-scm", scheme: "vscode" };
const PREFIX = "vscode://plastic-scm.plastic-scm/";

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** The Overview as the session renders it, with the extension's real links. */
function render(active: IActiveReview): string {
  return renderOverview(active, {
    isViewed: () => false,
    link: target => reviewLinkUri(BASE, { reviewId: active.review.id, target, workspaceId: active.workspaceId }),
    now: NOW,
  });
}

describe("Review links", () => {
  it("reads back every link it writes, whatever the path holds and however VS Code re-encodes it", () => {
    const odd = fileKey(file({ path: "/Assets/Odd & Ends/a=b+c %41 #1 ?x/Café 名前.cs", revisionId: 7 }));
    const written: IReviewLink[] = [
      { reviewId: 12831, target: { kind: "thread", threadId: 12915 }, workspaceId: "wk" },
      {
        reviewId: 1,
        target: { fileKey: odd, kind: "file", scope: "changes" },
        workspaceId: "d1b1c9e4-5f2a-4c1e-9f7e-0a1b2c3d4e5f",
      },
      { reviewId: 7551, target: { fileKey: odd, kind: "file", scope: "merged" }, workspaceId: "wk & co=1/2?#" },
      { reviewId: 7551, target: { fileKey: odd, kind: "file", scope: { changesetId: 3699 }}, workspaceId: "wk" },
    ];
    for (const link of written) {
      const href = reviewLinkUri(BASE, link);
      expect(href.startsWith(`${PREFIX}${link.target.kind}?`), href).to.equal(true);
      // Nothing in the query that encoding or decoding it would change.
      expect(href.substring(href.indexOf("?") + 1), href).to.match(/^[A-Za-z0-9=&_-]+$/);
      const uri = Uri.parse(href);
      // As the extension host revives it, and after the round trips a URI may take on its way.
      const received = [
        uri,
        Uri.parse(uri.toString()),
        Uri.parse(uri.toString(true)),
        Uri.from({ authority: uri.authority, path: uri.path, query: uri.query, scheme: uri.scheme }),
      ];
      for (const candidate of received) {
        expect(parseReviewLink(candidate), candidate.toString()).to.deep.equal({ kind: "link", link });
      }
    }
  });

  it("refuses a query the Overview does not write, and leaves other paths alone", () => {
    const key = base64(fileKey(file()));
    const thread = "thread?workspace=d2s&review=5";
    const changes = "file?workspace=d2s&review=5&scope=changes";
    const malformed = [
      "thread",
      "thread?",
      `${thread}`,
      `${thread}&thread=9&thread=9`,
      `${thread}&thread=9&extra=1`,
      `${thread}&thread=9=9`,
      `${thread}&thread=09`,
      `${thread}&thread=-9`,
      `${thread}&thread=9.0`,
      `${thread}&thread=99999999999999999`,
      `${thread}&thread=9#fragment`,
      "thread?workspace=d2t&review=5&thread=9",
      "thread?workspace=%%%&review=5&thread=9",
      "thread?workspace=&review=5&thread=9",
      "thread?workspace=d2s&review=0&thread=9",
      `${changes}&file=${base64("not json")}`,
      `${changes}&file=${base64("[\"/a.cs\",1.5]")}`,
      `${changes}&file=${base64("[\"/a.cs\",1,2]")}`,
      `${changes}&file=${base64("[ \"/a.cs\", 1 ]")}`,
      `${changes}&file=${base64("{\"path\":\"/a.cs\"}")}`,
      `file?workspace=d2s&review=5&scope=all&file=${key}`,
      `file?workspace=d2s&review=5&scope=cs0&file=${key}`,
      `file?workspace=d2s&review=5&file=${key}`,
    ];
    for (const path of malformed) {
      expect(parseReviewLink(Uri.parse(PREFIX + path)).kind, path).to.equal("malformed");
    }
    for (const path of [ "", "open?thread=9", "Thread?workspace=d2s&review=5&thread=9", "thread/9" ]) {
      expect(parseReviewLink(Uri.parse(PREFIX + path)).kind, path).to.equal("unknown");
    }
    // The shortest well-formed links, for contrast.
    expect(parseReviewLink(Uri.parse(`${PREFIX}${thread}&thread=9`)).kind).to.equal("link");
    expect(parseReviewLink(Uri.parse(`${PREFIX}${changes}&file=${key}`)).kind).to.equal("link");
  });

  describe("on a rendered Overview", () => {
    let branch: IScenario;
    let changeset: IScenario;
    before(async () => {
      branch = await loadScenario();
      changeset = await loadScenario(CHANGESET_REVIEW_ID);
    });

    it("links each thread with a line and each listed file to a row the handler opens", () => {
      const located = branch.discussions.threads.find(thread => thread.id === 12907)!;
      // A change request about the whole file has no line to open: its name stays plain text.
      const wholeFile = {
        ...located,
        anchor: { ...located.anchor, id: 13001, location: -1 },
        comments: [{ ...located.comments[0], id: 13001, location: -1 }],
        id: 13001,
      };
      const threads = branch.discussions.threads.concat([wholeFile]);
      const active = readyReview(branch, { discussions: { state: "ready", value: { ...branch.discussions, threads }}});
      const html = render(active);
      expectWellFormed(html);
      const found = expectHandlerLinksOpen(html, active, PREFIX);
      expect(found.map(link => link.target)).to.deep.equal([
        { kind: "thread", threadId: 12907 },
        { kind: "thread", threadId: 12915 },
      ]);
      expect(html).to.contain("Change request</span> GhostRunAnalyticsCollector.cs <span class=\"dim\">");
      expect(links(html).map(link => link.text)).to.include.members(["GhostRunAnalyticsCollector.cs:287"]);

      const csActive = readyReview(changeset);
      const csHtml = render(csActive);
      expectWellFormed(csHtml);
      const listed = changeset.files.final.files.find(row => row.path === "/Jenkinsfile_test_generator")!;
      expect(expectHandlerLinksOpen(csHtml, csActive, PREFIX).map(link => link.target)).to.deep.include({
        fileKey: fileKey(listed),
        kind: "file",
        scope: "changes",
      });
    });
  });
});
