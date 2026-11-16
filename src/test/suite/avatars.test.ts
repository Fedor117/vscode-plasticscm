import { avatarColor, avatarInitials, avatarsOf, GRAVATAR_ORIGIN, gravatarUrl } from "../../avatars";
import { expect } from "chai";

describe("Avatars", () => {
  it("asks Gravatar by the SHA-256 of the lower-cased, trimmed address", () => {
    // `printf 'dana.kim@example.com' | shasum -a 256`
    const hash = "8c6fac8607be494d2632d34ea57aaaac9cf166513daa4f4db8a2d809c6b8af45";
    expect(gravatarUrl("dana.kim@example.com")).to.equal(`${GRAVATAR_ORIGIN}/avatar/${hash}?s=64&d=404`);
    expect(gravatarUrl("  Dana.Kim@Example.com ")).to.equal(gravatarUrl("dana.kim@example.com"));
  });

  it("never sends the address itself", () => {
    expect(gravatarUrl("dana.kim@example.com")).to.not.match(/dana|kim|example/i);
  });

  it("has no picture for a user name that is not an email address", () => {
    const names = [ "", "build", "dana.kim", "dana@", "@example.com", "dana kim@example.com", "dana@localhost" ];
    for (const owner of names) {
      expect(gravatarUrl(owner), owner).to.equal(undefined);
    }
  });

  it("gives each owner initials and a colour, and a picture only to an address", () => {
    const avatars = avatarsOf([ "dana.kim@example.com", "build", "dana.kim@example.com" ]);
    expect(Object.keys(avatars)).to.deep.equal([ "dana.kim@example.com", "build" ]);
    expect(avatars["dana.kim@example.com"]).to.deep.equal({
      color: avatarColor("dana.kim"),
      initials: "DK",
      url: gravatarUrl("dana.kim@example.com"),
    });
    expect(avatars.build).to.deep.equal({ color: avatarColor("build"), initials: avatarInitials("build") });
  });
});
