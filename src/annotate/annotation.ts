import { IAnnotatedLine } from "../models";

/** ` `: an ordinary space would collapse inside a decoration. */
const PAD = " ";
const OWNER_WIDTH = 16;

/** `someone@example.com` -> `someone`; long names are cut, so the gutter keeps a steady width. */
export function shortOwner(owner: string): string {
  const name = owner.includes("@") ? owner.substring(0, owner.indexOf("@")) : owner;
  return name.length > OWNER_WIDTH ? `${name.substring(0, OWNER_WIDTH - 1)}…` : name;
}

function pad(text: string, width: number): string {
  return text + PAD.repeat(Math.max(0, width - text.length));
}

function isoDay(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The text in the gutter of every line, padded to one width so the code stays aligned. */
export function annotationLabels(lines: readonly IAnnotatedLine[]): string[] {
  const owners = Math.max(0, ...lines.map(line => shortOwner(line.owner).length));
  const changesets = Math.max(0, ...lines.map(line => String(line.changesetId).length));
  return lines.map(line => [
    pad(shortOwner(line.owner), owners),
    pad(`cs:${line.changesetId}`, changesets + 3),
    isoDay(line.date),
  ].join(PAD + PAD));
}

/** Width of the gutter in `ch`, for the decoration's `width`. */
export function annotationWidth(labels: readonly string[]): number {
  return Math.max(0, ...labels.map(label => label.length)) + 2;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function isAscii(text: string): boolean {

  return /^[\u0000-\u007f]*$/.test(text);
}

/**
 * Whether the annotation describes the text in the editor. cm annotates the
 * revision the workspace has loaded, so a file with pending changes would show
 * every line one off after the first edit. Compared by line count and, for the
 * lines both sides print the same way (ASCII), by content.
 */
export function annotationMatches(lines: readonly IAnnotatedLine[], documentText: string): boolean {
  const documentLines = splitLines(documentText);
  if (documentLines.length !== lines.length) {
    return false;
  }
  return lines.every((line, index) => {
    const mine = documentLines[index].replace(/^﻿/, "").trimEnd();
    const theirs = line.content.replace(/^﻿/, "").trimEnd();
    return !(isAscii(mine) && isAscii(theirs)) || mine === theirs;
  });
}

export type AnnotateFailure = "binary" | "notControlled" | "other";

/** cm's refusals worth a plain message; everything else is shown as cm said it. */
export function classifyAnnotateFailure(message: string): AnnotateFailure {
  if (/not supported to show differences|binary/i.test(message)) {
    return "binary";
  }
  const notControlled =
    /could not get revision information|not under source control|is not in the workspace|does not exist/i;
  if (notControlled.test(message)) {
    return "notControlled";
  }
  return "other";
}
