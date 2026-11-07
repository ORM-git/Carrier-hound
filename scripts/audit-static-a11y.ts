/**
 * Static accessibility (a11y) audit.
 *
 * Scans src/** for four classes of problems and exits non-zero when any are
 * found, so it can run as a hard gate in the test suite (suite-runner) and CI:
 *
 *   1. <img> / <Image> without an alt attribute
 *   2. onClick on <div>/<span> without a role
 *   3. <input> without an accessible label (aria-label / aria-labelledby /
 *      id for htmlFor / wrapped in a <label>)
 *   4. <button> without an accessible name (aria-label / aria-labelledby /
 *      title / visible text content)
 *
 * Opening tags are extracted across multiple lines (an attribute several
 * lines below the tag name is still seen), <label> wrapping is tracked with a
 * depth counter, and plain text node children count as a button's accessible
 * name. A sibling <label> without htmlFor does NOT label an input and is
 * still flagged.
 *
 * Run: npx tsx scripts/audit-static-a11y.ts
 */
import fs from "fs";
import path from "path";

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    const full = path.join(dirPath, file);
    if (fs.statSync(full).isDirectory()) {
      arrayOfFiles = getAllFiles(full, arrayOfFiles);
    } else if (file.endsWith(".tsx") || file.endsWith(".jsx")) {
      arrayOfFiles.push(full);
    }
  });
  return arrayOfFiles;
}

/**
 * Extract the complete JSX opening tag starting at `start` (index of "<tag"),
 * scanning forward across lines until the ">" that closes the tag at brace /
 * paren / bracket depth 0 and outside of quoted strings. Returns the tag text
 * and the index just past its end.
 */
function readOpeningTag(
  lines: string[],
  startLine: number,
  startCol: number
): { tag: string; endLine: number; endCol: number } {
  let depth = 0;
  let quote: string | null = null;
  let tag = "";
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    let j = i === startLine ? startCol : 0;
    for (; j < line.length; j++) {
      const ch = line[j];
      tag += ch;
      if (quote) {
        if (ch === quote && line[j - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
      else if (ch === ">" && depth === 0) {
        return { tag, endLine: i, endCol: j + 1 };
      }
    }
    tag += "\n";
  }
  return { tag, endLine: lines.length - 1, endCol: lines[lines.length - 1].length };
}

/** True when the opening tag closes itself (`/>`). */
function isSelfClosing(tag: string): boolean {
  return /\/\s*>\s*$/.test(tag);
}

/**
 * From a <button ...> opening tag position, collect the element body up to the
 * matching </button> (depth-tracked) and decide whether the button has an
 * accessible name: aria-label / aria-labelledby / title on the tag, or any
 * literal text / string-literal expression in the body outside <svg> blocks.
 */
function buttonHasAccessibleName(
  lines: string[],
  startLine: number,
  startCol: number
): { hasName: boolean; endLine: number } {
  const { tag, endLine, endCol } = readOpeningTag(lines, startLine, startCol);
  if (/aria-label\b|aria-labelledby\b|\btitle=/.test(tag)) {
    return { hasName: true, endLine };
  }
  if (isSelfClosing(tag)) return { hasName: false, endLine };

  let body = "";
  let depth = 1;
  for (let i = endLine; i < lines.length && depth > 0; i++) {
    const line = lines[i];
    let j = i === endLine ? endCol : 0;
    for (; j < line.length; j++) {
      if (line.startsWith("</button", j)) {
        depth--;
        if (depth === 0) return { hasName: bodyHasText(body), endLine: i };
        j += 7;
        continue;
      }
      if (line.startsWith("<button", j)) depth++;
      body += line[j];
    }
    body += "\n";
  }
  return { hasName: bodyHasText(body), endLine: lines.length - 1 };
}

function bodyHasText(body: string): boolean {
  // Remove svg blocks (icons) and HTML comments, then all tags.
  const noSvg = body.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const noTags = noSvg.replace(/<[^>]*>/g, " ");
  // Literal text node with an alphanumeric character.
  const withoutExprs = noTags.replace(/\{[^{}]*\}/g, " ");
  if (/[A-Za-z0-9]/.test(withoutExprs)) return true;
  // Any remaining expression counts as content (e.g. {children}, {item.label},
  // {t("copy")}) except a lone icon element variable such as {icon} or
  // {CloseIcon}, which renders no accessible name by itself.
  const exprs = noTags.match(/\{[^{}]*\}/g) || [];
  return exprs.some((e) => !/^\{\s*[A-Za-z]*([Ii]con|[Ss]pinner|[Ll]oader)\s*\}$/.test(e));
}

const files = getAllFiles("src");
const hits = {
  imgWithoutAlt: [] as string[],
  onClickOnDivSpan: [] as string[],
  inputWithoutLabel: [] as string[],
  buttonWithoutAccessibleName: [] as string[],
};

for (const file of files) {
  const relPath = path.relative(".", file).replace(/\\/g, "/");
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n");

  let labelDepth = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    const lineNum = idx + 1;

    // Track <label ...> ... </label> wrapping (labels never nest validly).
    const labelOpens = (line.match(/<label(?=[\s>]|$)/g) || []).length;
    const labelCloses = (line.match(/<\/label\s*>/g) || []).length;

    // 1. img / Image without alt
    const imgMatch = line.match(/<(?:img|Image)(?=[\s>]|$)/);
    if (imgMatch) {
      const col = line.indexOf(imgMatch[0]);
      const { tag } = readOpeningTag(lines, idx, col);
      if (!/\balt\s*=/.test(tag)) {
        hits.imgWithoutAlt.push(`${relPath}:${lineNum} -> ${trimmed.slice(0, 80)}`);
      }
    }

    // 2. onClick on div/span without role
    if (/<(?:div|span)(?=[\s>]|$)/.test(line) && line.includes("onClick=")) {
      const col = line.search(/<(?:div|span)(?=[\s>]|$)/);
      const { tag } = readOpeningTag(lines, idx, col);
      if (!/\brole\s*=/.test(tag) && tag.includes("onClick=")) {
        hits.onClickOnDivSpan.push(`${relPath}:${lineNum} -> ${trimmed.slice(0, 80)}`);
      }
    }

    // 3. input without accessible label
    const inputMatch = line.match(/<input(?=[\s>]|$)/);
    if (inputMatch) {
      const col = line.indexOf(inputMatch[0]);
      const { tag } = readOpeningTag(lines, idx, col);
      const isHidden = /\btype\s*=\s*["']hidden["']/.test(tag);
      // <label> opens/closes earlier on the same line count too.
      const before = line.slice(0, col);
      const inlineDepth =
        labelDepth +
        (before.match(/<label(?=[\s>]|$)/g) || []).length -
        (before.match(/<\/label\s*>/g) || []).length;
      const labeled =
        /\baria-label\b/.test(tag) ||
        /\baria-labelledby\b/.test(tag) ||
        /\bid\s*=/.test(tag) ||
        inlineDepth > 0;
      if (!isHidden && !labeled) {
        hits.inputWithoutLabel.push(`${relPath}:${lineNum} -> ${trimmed.slice(0, 80)}`);
      }
    }

    // 4. button without accessible name
    const buttonMatch = line.match(/<button(?=[\s>]|$)/);
    if (buttonMatch) {
      const col = line.indexOf(buttonMatch[0]);
      const { hasName } = buttonHasAccessibleName(lines, idx, col);
      if (!hasName) {
        hits.buttonWithoutAccessibleName.push(`${relPath}:${lineNum} -> ${trimmed.slice(0, 80)}`);
      }
    }

    labelDepth += labelOpens - labelCloses;
    if (labelDepth < 0) labelDepth = 0;
  }
}

console.log("===============================================================================");
console.log("                        STATIC ACCESSIBILITY (a11y) AUDIT                     ");
console.log("===============================================================================");
console.log(`\nSUMMARY COUNTS:`);
console.log(`- Images without alt attribute:          ${hits.imgWithoutAlt.length}`);
console.log(`- onClick on <div> or <span>:            ${hits.onClickOnDivSpan.length}`);
console.log(`- Inputs without accessible label/id:    ${hits.inputWithoutLabel.length}`);
console.log(`- Buttons without accessible name:       ${hits.buttonWithoutAccessibleName.length}`);

const allHits = [
  ...hits.imgWithoutAlt.map((h) => `[IMG-NO-ALT] ${h}`),
  ...hits.onClickOnDivSpan.map((h) => `[ONCLICK-DIV/SPAN] ${h}`),
  ...hits.inputWithoutLabel.map((h) => `[INPUT-NO-LABEL] ${h}`),
  ...hits.buttonWithoutAccessibleName.map((h) => `[BUTTON-NO-NAME] ${h}`),
];

if (allHits.length > 0) {
  console.log(`\nHITS${process.argv.includes("--all") ? "" : " (up to 30 shown; pass --all for full list)"}:`);
  allHits.slice(0, process.argv.includes("--all") ? allHits.length : 30).forEach((hit, i) => {
    console.log(`${String(i + 1).padStart(2, "0")}. ${hit}`);
  });
}
console.log("===============================================================================");

if (allHits.length > 0) {
  console.error(`\nFAIL static a11y audit: ${allHits.length} issue(s) found.`);
  process.exit(1);
}
console.log("\nPASS static a11y audit: no issues found.");
