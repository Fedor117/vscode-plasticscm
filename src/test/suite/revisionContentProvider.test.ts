import { decodeRevision } from "../../revisionContentProvider";
import { expect } from "chai";

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
