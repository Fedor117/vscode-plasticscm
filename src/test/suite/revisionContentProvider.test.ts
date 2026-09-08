import {
  decodeRevision,
  parseRevisionQuery,
  revisionScheme,
  toEmptyRevisionUri,
  toRevisionIdUri,
  toRevisionUri,
} from "../../revisionContentProvider";
import { expect } from "chai";
import { Uri } from "vscode";

const WORKSPACE_ID = "wk-1";
const REPOSITORY = "Nimbus/Nimbus@acme-studio@unity";

function withQuery(query: string): Uri {
  return Uri.from({ path: "/Assets/Code/Foo.cs", query, scheme: revisionScheme });
}

describe("toRevisionUri", () => {
  const uri = toRevisionUri(WORKSPACE_ID, Uri.file("/wk/Assets/Code/Foo.cs"), 3624);

  it("keeps the workspace path under the plastic scheme", () => {
    expect(uri.scheme).to.equal(revisionScheme);
    expect(uri.path).to.equal("/wk/Assets/Code/Foo.cs");
  });

  it("round trips through the query parser as a changeset query", () => {
    expect(parseRevisionQuery(uri)).to.eql({ changeset: 3624, wkId: WORKSPACE_ID });
  });
});

describe("toRevisionIdUri", () => {
  const uri = toRevisionIdUri(WORKSPACE_ID, "/Assets/Code/Foo.cs", 12347, REPOSITORY);

  it("keeps the server path under the plastic scheme so the language is still detected", () => {
    expect(uri.scheme).to.equal(revisionScheme);
    expect(uri.path).to.equal("/Assets/Code/Foo.cs");
  });

  it("round trips through the query parser as a revision id query", () => {
    expect(parseRevisionQuery(uri)).to.eql({ rep: REPOSITORY, revid: 12347, wkId: WORKSPACE_ID });
  });

  it("keeps an empty repository as the bare spec marker", () => {
    expect(parseRevisionQuery(toRevisionIdUri(WORKSPACE_ID, "/Assets/Code/Foo.cs", 12347, "")))
      .to.eql({ rep: "", revid: 12347, wkId: WORKSPACE_ID });
  });

  it("keeps a path with spaces intact", () => {
    const spaced = toRevisionIdUri(WORKSPACE_ID, "/Assets/Art/Race UI/Icons/Icon.png", 12344, REPOSITORY);

    expect(spaced.path).to.equal("/Assets/Art/Race UI/Icons/Icon.png");
  });

  it("makes two revisions of one path distinct documents", () => {
    const other = toRevisionIdUri(WORKSPACE_ID, "/Assets/Code/Foo.cs", 11593, REPOSITORY);

    expect(other.toString()).to.not.equal(uri.toString());
  });
});

describe("toEmptyRevisionUri", () => {
  const uri = toEmptyRevisionUri(WORKSPACE_ID, "/Assets/Code/Foo.cs");

  it("keeps the server path under the plastic scheme", () => {
    expect(uri.scheme).to.equal(revisionScheme);
    expect(uri.path).to.equal("/Assets/Code/Foo.cs");
  });

  it("round trips through the query parser as an empty query", () => {
    expect(parseRevisionQuery(uri)).to.eql({ empty: true, wkId: WORKSPACE_ID });
  });

  it("is a different document from a revision of the same path", () => {
    const revision = toRevisionIdUri(WORKSPACE_ID, "/Assets/Code/Foo.cs", 12347, REPOSITORY);

    expect(uri.toString()).to.not.equal(revision.toString());
  });
});

describe("parseRevisionQuery", () => {
  it("returns undefined for an empty query", () => {
    expect(parseRevisionQuery(withQuery(""))).to.be.undefined;
  });

  it("returns undefined for a query that is not JSON", () => {
    expect(parseRevisionQuery(withQuery("not json"))).to.be.undefined;
  });

  it("returns undefined for JSON that is not an object", () => {
    expect(parseRevisionQuery(withQuery("42"))).to.be.undefined;
    expect(parseRevisionQuery(withQuery("null"))).to.be.undefined;
  });

  it("returns undefined without a workspace id", () => {
    expect(parseRevisionQuery(withQuery(JSON.stringify({ revid: 1 })))).to.be.undefined;
  });

  it("returns undefined when no shape matches", () => {
    expect(parseRevisionQuery(withQuery(JSON.stringify({ wkId: WORKSPACE_ID })))).to.be.undefined;
    expect(parseRevisionQuery(withQuery(JSON.stringify({ revid: "12", wkId: WORKSPACE_ID })))).to.be.undefined;
  });

  it("defaults a missing repository to the bare spec marker", () => {
    expect(parseRevisionQuery(withQuery(JSON.stringify({ revid: 12, wkId: WORKSPACE_ID }))))
      .to.eql({ rep: "", revid: 12, wkId: WORKSPACE_ID });
  });

  it("lets the empty marker win over other fields", () => {
    expect(parseRevisionQuery(withQuery(JSON.stringify({ empty: true, revid: 12, wkId: WORKSPACE_ID }))))
      .to.eql({ empty: true, wkId: WORKSPACE_ID });
  });
});

describe("decodeRevision", () => {
  it("strips a UTF-8 BOM, which VS Code strips from the side being diffed against", () => {
    const buffer = Buffer.concat([
      Buffer.from([ 0xef, 0xbb, 0xbf ]),
      Buffer.from("using System;", "utf8"),
    ]);

    expect(decodeRevision(buffer)).to.equal("using System;");
  });

  it("decodes UTF-16LE rather than returning mojibake", () => {
    const buffer = Buffer.concat([
      Buffer.from([ 0xff, 0xfe ]),
      Buffer.from("using System;", "utf16le"),
    ]);

    expect(decodeRevision(buffer)).to.equal("using System;");
  });

  it("decodes UTF-16BE, which Node has no decoder for", () => {
    const buffer = Buffer.concat([
      Buffer.from([ 0xfe, 0xff ]),
      Buffer.from(Buffer.from("using System;", "utf16le")).swap16(),
    ]);

    expect(decodeRevision(buffer)).to.equal("using System;");
  });

  it("leaves a plain UTF-8 file untouched", () => {
    expect(decodeRevision(Buffer.from("using System;", "utf8"))).to.equal("using System;");
  });

  it("keeps a U+FEFF that is content rather than a byte order mark", () => {
    // The BOM is only a BOM at offset 0; the same code point mid-file is a
    // zero-width no-break space and has to survive.
    const text = "a﻿b";

    expect(decodeRevision(Buffer.from(text, "utf8"))).to.equal(text);
  });

  it("returns an empty string for an empty revision", () => {
    expect(decodeRevision(Buffer.alloc(0))).to.equal("");
  });
});
