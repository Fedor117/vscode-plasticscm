import { privateAncestorsOf, topmost } from "../../commands/addToSourceControl";
import { expect } from "chai";

describe("privateAncestorsOf", () => {
  it("collects the unselected private directories above the selection", () => {
    const privateDirectories = [ "/wk/new", "/wk/new/nested", "/wk/elsewhere" ];

    expect(privateAncestorsOf(privateDirectories, ["/wk/new/nested/a.cs"]))
      .to.deep.equal([ "/wk/new", "/wk/new/nested" ]);
  });

  it("orders parents before children, so each add has a parent to attach to", () => {
    const privateDirectories = [ "/wk/a/b/c", "/wk/a", "/wk/a/b" ];

    expect(privateAncestorsOf(privateDirectories, ["/wk/a/b/c/d.cs"]))
      .to.deep.equal([ "/wk/a", "/wk/a/b", "/wk/a/b/c" ]);
  });

  it("skips directories the user already selected, which the main add covers", () => {
    const privateDirectories = [ "/wk/new", "/wk/new/nested" ];

    expect(privateAncestorsOf(privateDirectories, [ "/wk/new", "/wk/new/nested/a.cs" ]))
      .to.deep.equal(["/wk/new/nested"]);
  });

  it("ignores private directories that no selected path lives under", () => {
    expect(privateAncestorsOf([ "/wk/other", "/wk/newer" ], ["/wk/new/a.cs"]))
      .to.deep.equal([]);
  });
});

describe("topmost", () => {
  it("drops paths a selected ancestor already covers, since the add is recursive", () => {
    const paths = [ "/wk/dir", "/wk/dir/a.cs", "/wk/dir/nested/b.cs", "/wk/other.cs" ];

    expect(topmost(paths)).to.deep.equal([ "/wk/dir", "/wk/other.cs" ]);
  });

  it("keeps siblings whose names merely share a prefix", () => {
    expect(topmost([ "/wk/a", "/wk/ab" ])).to.have.lengthOf(2);
  });
});
