import { expect } from "chai";
import { isSameRepository } from "../../../commands/history";

describe("isSameRepository", () => {
  it("matches the same repository across the server aliases cm prints", () => {
    // `cm status --xml` reports the cloud id, `cm diff` the organisation alias.
    expect(isSameRepository(
      "Nimbus/Nimbus@acme-studio@unity",
      "Nimbus/Nimbus@1234567890123@cloud")).to.be.true;
  });

  it("matches an on-premise spec against itself", () => {
    expect(isSameRepository("codice@skull:8087", "codice@skull:8087")).to.be.true;
  });

  it("separates an xlinked repository from the workspace one", () => {
    expect(isSameRepository(
      "SharedLibs@acme-studio@unity",
      "Nimbus/Nimbus@acme-studio@unity")).to.be.false;
  });

  it("keeps repository names that only differ after a slash apart", () => {
    expect(isSameRepository(
      "Nimbus/Tools@srv", "Nimbus/Nimbus@srv")).to.be.false;
  });

  it("tolerates a spec with no server part", () => {
    expect(isSameRepository("Nimbus/Nimbus", "Nimbus/Nimbus@srv")).to.be.true;
  });

  it("ignores surrounding whitespace", () => {
    expect(isSameRepository(" Nimbus/Nimbus @srv", "Nimbus/Nimbus@other")).to.be.true;
  });
});
