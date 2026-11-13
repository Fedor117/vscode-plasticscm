import { BaseCmParser } from "../baseCmParser";
import { IAnnotatedLine } from "../../../models";

/**
 * Between the fields. Every field before `{content}` is a number, a date in a
 * fixed pattern, or a user name (an email or a domain account), none of which can
 * contain angle brackets, so the first four separators in a line always belong to
 * the format and whatever follows is the line's content, separators included.
 */
export const ANNOTATE_SEPARATOR = "<|>";

/** Dates in a fixed, unambiguous pattern; cm's default follows the machine's locale. */
export const ANNOTATE_DATE_FORMAT = "yyyy-MM-ddTHH:mm:ss";

export class AnnotateParser extends BaseCmParser<IAnnotatedLine[]> {
  public parse(): Promise<IAnnotatedLine[] | undefined> {
    const lines: IAnnotatedLine[] = [];
    for (const raw of this.mOutputBuffer) {
      const line = parseAnnotateLine(raw);
      if (line) {
        lines.push(line);
      }
    }
    return Promise.resolve(lines);
  }
}

/** One output line, or undefined for anything that is not an annotation (progress, warnings). */
export function parseAnnotateLine(raw: string): IAnnotatedLine | undefined {
  const fields: string[] = [];
  let rest = raw;
  for (let i = 0; i < 4; i++) {
    const at = rest.indexOf(ANNOTATE_SEPARATOR);
    if (at < 0) {
      return undefined;
    }
    fields.push(rest.substring(0, at));
    rest = rest.substring(at + ANNOTATE_SEPARATOR.length);
  }

  const [ changeset, lineNumber, date, owner ] = fields;
  if (!/^\d+$/.test(changeset) || !/^\d+$/.test(lineNumber)) {
    return undefined;
  }

  const parsed = new Date(date);
  return {
    changesetId: parseInt(changeset, 10),
    content: rest.replace(/\r$/, ""),
    date: isNaN(parsed.getTime()) ? new Date(0) : parsed,
    line: parseInt(lineNumber, 10),
    owner,
  };
}
