/**
 * Splits text into lines the way VS Code's text model does: `\r\n`, `\n` and a
 * lone `\r` all end a line. Anything narrower turns a CR-only file into one long
 * line here while the editor shows hundreds, and every comment on it would then
 * fall outside the revision. Every line count in the review code goes through
 * this, so a comment's LOCATION means the same line everywhere.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Conservative mapping: an unchanged anchor plus its surrounding lines must occur
 * exactly once in both texts. Changed/deleted/duplicate context stays historical.
 * Indices are zero-based internally; cm's location is normalized by the caller.
 */
export function mapReviewLine(original: string, current: string, line: number): number | undefined {
  const before = splitLines(original);
  const after = splitLines(current);
  if (!Number.isInteger(line) || line < 0 || line >= before.length) {
    return undefined;
  }
  if (original === current) {
    return line;
  }
  if (!before[line].trim()) {
    return undefined;
  }
  const start = Math.max(0, line - 2);
  const end = Math.min(before.length, line + 3);
  const context = before.slice(start, end);
  const find = (lines: string[]) => {
    const matches: number[] = [];
    for (let index = 0; index <= lines.length - context.length; index++) {
      if (context.every((text, offset) => lines[index + offset] === text)) {
        matches.push(index);
      }
    }
    return matches;
  };
  const oldMatches = find(before);
  const newMatches = find(after);
  return oldMatches.length === 1 && newMatches.length === 1 ? newMatches[0] + line - start : undefined;
}
