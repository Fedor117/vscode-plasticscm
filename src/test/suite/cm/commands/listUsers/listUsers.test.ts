import { IServerMember, ListUsers, repositoryServer, ServerMembersParser } from "../../../../../cm/commands";
import { expect } from "chai";
import { mockShell } from "../findChangesets/shellMock";

/** `cm listusers <server>` as cm 11 prints it: a padded name column, then the type. Every name is made up. */

async function parse(...lines: string[]): Promise<IServerMember[]> {
  const parser = new ServerMembersParser();
  lines.forEach(line => parser.readLineOut(line));
  return parser.parse();
}

describe("ListUsers command", () => {
  it("asks for the server's users and groups, with a bound on the wait", async () => {
    const shell = mockShell<IServerMember[]>({ result: [{ name: "Developers", type: "group" }], success: true });
    expect(await ListUsers.run(shell.mock.object, "acme-studio@unity")).to.eql([{ name: "Developers", type: "group" }]);
    expect(shell.calls).to.eql([
      { args: ["acme-studio@unity"], command: "listusers", options: { timeoutMillis: 20000 }},
    ]);
  });

  it("throws what cm reported, and refuses a server it cannot pass", async () => {
    const failing = mockShell<IServerMember[]>({ error: new Error("No such server."), success: false });
    const caught = await ListUsers.run(failing.mock.object, "acme-studio@unity").then(() => undefined, (e: Error) => e);
    expect(caught?.message).to.equal("No such server.");

    const shell = mockShell<IServerMember[]>({ result: [], success: true });
    const refused = await ListUsers.run(shell.mock.object, "acme\"studio").then(() => undefined, (e: Error) => e);
    expect(refused?.message).to.match(/cannot be passed to cm/);
    expect(shell.calls).to.eql([]);
  });

  it("reads the type from the end of each line, so names keep their spaces", async () => {
    expect(await parse(
      "dana.kim@example.com                       User",
      "Client Engineers                           Group",
      "5b0c1e2a-0000-4000-8000-00000000a001-admin Group",
      "",
      "sam.rivera@example.com user ",
    )).to.eql([
      { name: "dana.kim@example.com", type: "user" },
      { name: "Client Engineers", type: "group" },
      { name: "5b0c1e2a-0000-4000-8000-00000000a001-admin", type: "group" },
      { name: "sam.rivera@example.com", type: "user" },
    ]);
  });

  it("skips lines that name neither a user nor a group", async () => {
    expect(await parse("Getting organization providers...", "User", "  Group")).to.eql([]);
  });

  it("takes the server after the repository's name", () => {
    expect(repositoryServer("Nimbus/Nimbus@acme-studio@unity")).to.equal("acme-studio@unity");
    expect(repositoryServer("default@localhost:8087")).to.equal("localhost:8087");
    for (const spec of [ undefined, "", "Nimbus", "Nimbus@", "unknown@unknown" ]) {
      expect(repositoryServer(spec), String(spec)).to.equal(undefined);
    }
  });
});
