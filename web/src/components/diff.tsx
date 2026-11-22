/** Lines are told apart by their first character, which stays in the text; weight and background only repeat it. */
function lineKind(line: string): "added" | "removed" | "hunk" | "header" | "context" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || /^(new|deleted) file mode /.test(line)) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/**
 * One line of a diff: its sign in one cell and its text in the next, as an insertion, a deletion or neither.
 * `plain` is for lines that are known to be changes and nothing else, so a removed line that starts with "--" is not read as a header.
 */
export function DiffLine({ line, plain = false }: { line: string; plain?: boolean }) {
  const kind = plain ? (line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context") : lineKind(line);
  if (kind === "added" || kind === "removed") {
    const cells = (
      <>
        <span className="gw-diff__sign">{line[0]}</span>
        <span className="gw-diff__text">{line.slice(1)}</span>
      </>
    );
    return kind === "added" ? (
      <ins data-line={kind} className="gw-diff__line gw-diff__line--added">
        {cells}
      </ins>
    ) : (
      <del data-line={kind} className="gw-diff__line gw-diff__line--removed">
        {cells}
      </del>
    );
  }
  // A context line starts with the space that is its sign. Git's own header lines, hunk headers and notes have none of their own.
  const context = kind === "context";
  return (
    <span data-line={kind} className={context ? "gw-diff__line" : "gw-diff__line gw-diff__line--hunk"}>
      <span className="gw-diff__sign"> </span>
      <span className="gw-diff__text">{context && line.startsWith(" ") ? line.slice(1) : line}</span>
    </span>
  );
}
