/**
 * Third-party Script Risk guard (Backend sheet BE #68).
 *
 * Policy (docs/third-party-scripts.md): every <script> loaded from a
 * third-party origin must carry Subresource Integrity, or be named in the
 * documented exception list with its compensating controls. This test scans
 * src/ for external script URLs and keeps the doc and the code in lockstep.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const DOC_PATH = path.join(ROOT, "docs", "third-party-scripts.md");

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** URLs assigned to script.src or used as <script src> / Script src. */
function findExternalScriptRefs(file: string): { url: string; line: number }[] {
  return scanExternalScriptRefs(readFileSync(file, "utf8"));
}

function scanExternalScriptRefs(source: string): { url: string; line: number }[] {
  const refs: { url: string; line: number }[] = [];
  const patterns = [
    /\bscript\.src\s*=\s*["'](https?:\/\/[^"']+)["']/g,
    /<(?:script|Script)\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/g,
    /\bworkerSrc\s*=\s*["'](https?:\/\/[^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of Array.from(source.matchAll(pattern))) {
      refs.push({ url: match[1], line: source.slice(0, match.index).split("\n").length });
    }
  }
  return refs;
}

function parseGuardBlock(doc: string): { url: string; attrs: string }[] {
  const m = doc.match(/```guard\n([\s\S]*?)```/);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("script:"))
    .map((l) => {
      const parts = l.split("|").map((p) => p.trim());
      return { url: parts[0].replace(/^script:\s*/, ""), attrs: parts.slice(1).join(" | ") };
    });
}

describe("third-party script inventory (BE #68)", () => {
  it("finds multiline, single-quoted, and repeated script references", () => {
    const refs = scanExternalScriptRefs([
      "script.src =",
      "  'https://example.test/a.js'; script.src = \"https://example.test/b.js\";",
      "<Script\n src='https://example.test/c.js' />",
      "pdfjs.GlobalWorkerOptions.workerSrc =\n  'https://example.test/worker.js';",
    ].join("\n"));
    expect(refs.map((ref) => ref.url).sort()).toEqual([
      "https://example.test/a.js", "https://example.test/b.js",
      "https://example.test/c.js", "https://example.test/worker.js",
    ]);
    expect(refs.every((ref) => ref.line > 0)).toBe(true);
  });

  it("every external script URL in src/ is named in the guard block", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const guard = parseGuardBlock(doc);
    expect(guard.length).toBeGreaterThan(0);
    const documented = new Set(guard.map((g) => g.url));

    const refs: { file: string; url: string; line: number }[] = [];
    for (const file of collectSourceFiles(path.join(ROOT, "src"))) {
      if (file.endsWith("thirdPartyScripts.test.ts")) continue;
      for (const ref of findExternalScriptRefs(file)) {
        refs.push({ file: path.relative(ROOT, file), ...ref });
      }
    }
    for (const ref of refs) {
      expect(
        documented.has(ref.url),
        `undocumented third-party script ${ref.url} at ${ref.file}:${ref.line} - add it to docs/third-party-scripts.md`,
      ).toBe(true);
    }
  });

  it("every guard-block entry without an exception carries an SRI pin", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    for (const entry of parseGuardBlock(doc)) {
      if (/exception:|no-sri:/.test(entry.attrs)) continue;
      expect(entry.attrs).toMatch(/sri:\s*sha384-[A-Za-z0-9+/=]+/);
      expect(entry.attrs).toContain("crossorigin:");
    }
  });

  it("the pdf.js pin in parser.ts matches the guard block", () => {
    const parser = readFileSync(
      path.join(ROOT, "src", "lib", "resume", "parser.ts"),
      "utf8",
    );
    const pdfUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    expect(parser).toContain(pdfUrl);
    const doc = readFileSync(DOC_PATH, "utf8");
    const entry = parseGuardBlock(doc).find((g) => g.url === pdfUrl);
    expect(entry, "pdf.min.js missing from guard block").toBeTruthy();
    const docHash = entry!.attrs.match(/sri:\s*(sha384-[A-Za-z0-9+/=]+)/)![1];
    expect(parser).toContain(`script.integrity =\n            "${docHash}"`);
    expect(parser).toContain('script.crossOrigin = "anonymous"');
  });

  it("razorpay checkout.js stays a documented exception (vendor-mutated URL)", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const entry = parseGuardBlock(doc).find((g) =>
      g.url.includes("checkout.razorpay.com"),
    );
    expect(entry, "razorpay checkout.js missing from guard block").toBeTruthy();
    expect(entry!.attrs).toContain("exception:");
    expect(entry!.attrs).toContain("mitigations:");
  });
});
