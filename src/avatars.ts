import { createHash } from "crypto";
import { workspace } from "vscode";

/** The setting that lets the views ask Gravatar for authors' pictures. */
export const GRAVATAR_SETTING = "plastic-scm.avatars.gravatar";

/** The only origin a picture is loaded from; the webviews' CSP names it. */
export const GRAVATAR_ORIGIN = "https://www.gravatar.com";

/** Twice the largest size an avatar is drawn at, so it stays sharp on a dense screen. */
const GRAVATAR_PIXELS = 64;

/** What a view needs to draw one author: initials on a colour, under a picture when there is one. */
export interface IAvatar {
  readonly initials: string;
  readonly color: string;
  /** A picture that may not exist: the request answers 404 then, and the initials stay. */
  readonly url?: string;
}

/** Avatars by the owner exactly as cm writes it. */
export type Avatars = Record<string, IAvatar>;

/**
 * Avatar backgrounds: ten hues, so the few people on one review rarely share
 * one, each dark enough for white initials at 5:1 or better.
 */
const AVATAR_COLORS = [
  "#b0385a", "#2f6fc0", "#9a5716", "#7a4fb0", "#1d7586", "#a3452a", "#5b5fc7", "#237257", "#8e4a96", "#4d7a1f",
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An author's initials: `TO` for tom.okafor, the first two letters of a one-word name. */
export function avatarInitials(owner: string): string {
  const name = shortName(owner);
  const words = name.split(/[._\-\s]+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map(word => Array.from(word)[0]) : Array.from(name).slice(0, 2);
  return letters.join("").toUpperCase();
}

/** An author's avatar colour, picked from the name so an author keeps it everywhere. */
export function avatarColor(owner: string): string {
  let hash = 0;
  for (const char of shortName(owner).toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000003;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * The Gravatar picture of an owner that is an email address, as cloud users
 * are; undefined for any other user name. Gravatar sees the SHA-256 of the
 * address, never the address, and answers 404 when it has no picture for it.
 */
export function gravatarUrl(owner: string): string | undefined {
  const email = owner.trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return undefined;
  }
  const hash = createHash("sha256").update(email, "utf8").digest("hex");
  return `${GRAVATAR_ORIGIN}/avatar/${hash}?s=${GRAVATAR_PIXELS}&d=404`;
}

/** The avatars of `owners`, each with its Gravatar picture when the owner is an email address. */
export function avatarsOf(owners: Iterable<string>): Avatars {
  const avatars: Avatars = {};
  for (const owner of owners) {
    if (!Object.prototype.hasOwnProperty.call(avatars, owner)) {
      const url = gravatarUrl(owner);
      avatars[owner] = { color: avatarColor(owner), initials: avatarInitials(owner), ...(url ? { url } : {}) };
    }
  }
  return avatars;
}

/** Whether the user lets the views load authors' pictures from Gravatar. */
export function gravatarEnabled(): boolean {
  return workspace.getConfiguration().get<boolean>(GRAVATAR_SETTING, false);
}

/** `avatarsOf(owners)` while the Gravatar setting is on; undefined while it is off, and the views show names only. */
export function avatarsWhenOn(owners: Iterable<string>): Avatars | undefined {
  return gravatarEnabled() ? avatarsOf(owners) : undefined;
}

/** The owner up to the first `@`, or `?` when nothing is left. */
function shortName(owner: string): string {
  const at = owner.indexOf("@");
  return (at < 0 ? owner : owner.substring(0, at)).trim() || "?";
}
