import * as xml2js from "xml2js";
import { BaseCmParser } from "../baseCmParser";
import { IListedReviewer } from "./codeReview";

/**
 * Reads `cm codereview reviewer list <id> --xml`: a `Reviewers` root with one
 * `Reviewer` per reviewer, each holding `User`, `Status` and `Type`, as cm's
 * help documents it. Tag names are matched without case. Output without a
 * `Reviewers` root (an error message, a truncated document) is an error, not
 * an empty list; an empty `Reviewers` element is a review without reviewers.
 */
export class ReviewerListParser extends BaseCmParser<IListedReviewer[]> {
  public async parse(): Promise<IListedReviewer[] | undefined> {
    const xml = this.mOutputBuffer.join("\n").replace(/^﻿/, "");
    if (!/<Reviewers(?:\s|\/?>)/i.test(xml)) {
      this.mParseError = new Error("cm did not print a list of reviewers.");
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = await xml2js.parseStringPromise(xml, {
        explicitArray: true,
        tagNameProcessors: [xml2js.processors.normalize],
        trim: true,
      });
    } catch (error) {
      this.mParseError = new Error(`cm printed reviewers that could not be read: ${(error as Error).message}`);
      return undefined;
    }
    const root = isRecord(parsed) ? parsed.reviewers : undefined;
    const rows = isRecord(root) && Array.isArray(root.reviewer) ? root.reviewer : [];
    return rows.filter(isRecord).map(row => ({
      name: text(row.user),
      status: text(row.status),
      type: text(row.type).toLowerCase() === "group" ? "group" as const : "user" as const,
    })).filter(reviewer => reviewer.name.length > 0);
  }
}

function text(value: unknown): string {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string") {
    return first.trim();
  }
  if (isRecord(first) && typeof first._ === "string") {
    return first._.trim();
  }
  return "";
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
