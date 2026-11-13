import { annotationHover, describeAnnotateFailure } from "../../../commands/annotate";
import {
  annotationLabels,
  annotationMatches,
  annotationWidth,
  classifyAnnotateFailure,
  shortOwner,
} from "../../../annotate/annotation";
import { IAnnotatedLine, IHistoryChangeset } from "../../../models";
import { expect } from "chai";
import { Uri } from "vscode";

function line(n: number, changesetId: number, content: string, owner = "someone@example.com"): IAnnotatedLine {
  return { changesetId, content, date: new Date(2026, 2, 9, 12), line: n, owner };
}

describe("Annotate presentation", () => {
  it("shortens an email to the name before the @", () => {
    expect(shortOwner("someone@example.com")).to.equal("someone");
    expect(shortOwner("admin")).to.equal("admin");
  });

  it("cuts a long name", () => {
    expect(shortOwner("a-very-long-user-name-indeed")).to.have.length(16).and.to.match(/…$/);
  });

  it("pads every label to one width", () => {
    const labels = annotationLabels([ line(1, 7, "a"), line(2, 12345, "b", "admin") ]);
    expect(labels[0]).to.have.length(labels[1].length);
    expect(labels[0]).to.contain("cs:7");
    expect(labels[1]).to.contain("2026-03-09");
    expect(annotationWidth(labels)).to.be.greaterThan(labels[0].length);
  });

  it("copes with no lines", () => {
    expect(annotationLabels([])).to.eql([]);
  });
});

describe("annotationMatches", () => {
  const lines = [ line(1, 1, "alpha"), line(2, 1, "beta  "), line(3, 2, "") ];

  it("accepts the text the annotation was made from, with any line ending and trailing newline", () => {
    expect(annotationMatches(lines, "alpha\nbeta\n\n")).to.equal(true);
    expect(annotationMatches(lines, "alpha\r\nbeta\r\n\r\n")).to.equal(true);
  });

  it("rejects a different number of lines", () => {
    expect(annotationMatches(lines, "alpha\nbeta\n")).to.equal(false);
  });

  it("rejects a changed line", () => {
    expect(annotationMatches(lines, "alpha\nbetx\n\n")).to.equal(false);
  });

  it("does not compare lines with non-ASCII text, which cm and the editor may print differently", () => {
    expect(annotationMatches([line(1, 1, "café")], "cafÃ©\n")).to.equal(true);
  });

  it("ignores a byte order mark on the first line", () => {
    expect(annotationMatches([line(1, 1, "alpha")], "﻿alpha")).to.equal(true);
  });
});

describe("Annotate failures", () => {
  it("recognises binary files and uncontrolled files by cm's wording", () => {
    expect(classifyAnnotateFailure("The filetype of x.png is not supported to show differences.")).to.equal("binary");
    expect(classifyAnnotateFailure("Could not get revision information for ./x.txt.")).to.equal("notControlled");
    expect(classifyAnnotateFailure("connection refused")).to.equal("other");
  });

  it("says in words what happened", () => {
    expect(describeAnnotateFailure("binary", "a.png", "")).to.contain("binary file");
    expect(describeAnnotateFailure("notControlled", "a.txt", "")).to.contain("not under Plastic SCM source control");
    expect(describeAnnotateFailure("other", "a.txt", "boom")).to.contain("boom");
  });
});

describe("Annotate hover", () => {
  const changeset: IHistoryChangeset = {
    branch: "/main/task7", comment: "Tune the jump", date: new Date(0), guid: "g", id: 40, owner: "x",
    parentId: 39, repository: "Nimbus/Nimbus", server: "acme-studio@unity",
  };

  it("shows the comment and links to the changeset's changes", () => {
    // appendText escapes spaces as &nbsp;; the reader sees them as spaces.
    const hover = annotationHover("wk-1", Uri.file("/work/a.cs"), line(1, 40, "x"), changeset).value
      .replace(/&nbsp;/g, " ");
    expect(hover).to.contain("cs:40");
    expect(hover).to.contain("/main/task7");
    expect(hover).to.contain("Tune the jump");
    expect(hover).to.contain("command:plastic-scm.annotate.openChanges?");
    expect(hover).to.contain("command:plastic-scm.compare.showChangeset?");
  });

  it("still names the changeset when its details could not be read", () => {
    const hover = annotationHover("wk-1", Uri.file("/work/a.cs"), line(1, 40, "x"), undefined).value;
    expect(hover).to.contain("cs:40");
  });
});
