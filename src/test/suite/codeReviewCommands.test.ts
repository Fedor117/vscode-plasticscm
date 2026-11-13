import * as fs from "fs";
import * as path from "path";
import {
  CODE_REVIEW_COMMANDS,
  describeReviewers,
  namesOf,
  parseReviewerNames,
  reviewerItems,
  reviewRefFromArg,
} from "../../commands/codeReview";
import { expect } from "chai";

describe("Code review commands", () => {
  describe("parseReviewerNames", () => {
    it("splits users and groups", () => {
      expect(parseReviewerNames(" dana.kim@example.com, group:Developers ,GROUP: Leads ").names)
        .to.eql({ groups: [ "Developers", "Leads" ], users: ["dana.kim@example.com"] });
    });

    it("says what is wrong instead of naming nobody or a name cm cannot take", () => {
      expect(parseReviewerNames(" , ").problem).to.equal("Name at least one reviewer.");
      expect(parseReviewerNames("someone@example.com, bad\"name").problem).to.match(/^bad"name: /);
      expect(parseReviewerNames("group:").problem).to.match(/^group:: /);
    });
  });

  describe("reviewer rows", () => {
    const listed = [
      { name: "dana.kim@example.com", status: "Reviewed", type: "user" as const },
      { name: "Developers", status: "", type: "group" as const },
    ];

    it("shows the status and marks groups", () => {
      expect(reviewerItems(listed).map(item => [ item.label, item.description ])).to.eql([
        [ "dana.kim@example.com", "Reviewed" ],
        [ "Developers", "group" ],
      ]);
    });

    it("names the picked rows by type, and leaves out a row that is no reviewer", () => {
      expect(namesOf([ ...reviewerItems(listed), { label: "All reviewers" }]))
        .to.eql({ groups: ["Developers"], users: ["dana.kim@example.com"] });
    });

    it("describes them for a message", () => {
      expect(describeReviewers({ users: ["someone@example.com"] })).to.equal("someone@example.com");
      expect(describeReviewers({ groups: ["Developers"], users: [ "a@example.com", "b@example.com" ] }))
        .to.equal("a@example.com, b@example.com and the group Developers");
    });
  });

  describe("reviewRefFromArg", () => {
    const review = { id: 12, owner: "someone@example.com", title: "Tyres" };
    const row = { kind: "review", review, workspaceId: "wk1" };

    it("reads a Reviews row", () => {
      expect(reviewRefFromArg(row))
        .to.eql({ id: 12, owner: "someone@example.com", title: "Tyres", workspaceId: "wk1" });
    });

    it("ignores every other argument", () => {
      for (const arg of [
        undefined, null, "12", {}, { ...row, kind: "file" }, { ...row, workspaceId: 1 },
        { ...row, review: undefined }, { ...row, review: { id: "12" }}, { ...row, review: { id: 1.5 }},
      ]) {
        expect(reviewRefFromArg(arg), JSON.stringify(arg)).to.equal(undefined);
      }
    });
  });

  describe("contributions", () => {
    interface IEntry { command: string; when?: string }
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
      contributes: { commands: IEntry[]; menus: Record<string, IEntry[]> };
    };
    const reviewerCommands = [
      CODE_REVIEW_COMMANDS.addReviewers, CODE_REVIEW_COMMANDS.removeReviewers, CODE_REVIEW_COMMANDS.requestReviewAgain,
    ];
    const whenOf = (menu: string, id: string) =>
      pkg.contributes.menus[menu].filter(entry => entry.command === id).map(entry => entry.when);

    it("declares every command", () => {
      for (const id of Object.values(CODE_REVIEW_COMMANDS)) {
        expect(pkg.contributes.commands.some(entry => entry.command === id), id).to.equal(true);
      }
    });

    it("offers the reviewer commands on the open review and on Reviews rows", () => {
      for (const id of reviewerCommands) {
        expect(whenOf("commandPalette", id), id).to.eql(["plastic-scm.reviews.hasActiveReview"]);
        expect(whenOf("view/title", id), id)
          .to.eql(["view == plastic-scm.reviews.active && plastic-scm.reviews.hasActiveReview"]);
        expect(whenOf("view/item/context", id), id)
          .to.eql(["view == plastic-scm.reviews.list && viewItem =~ /^review;/"]);
      }
    });
  });
});
