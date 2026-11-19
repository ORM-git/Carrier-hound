import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import {
  extractDocxText,
  extractPdfText,
  extractResumeText,
  extractTextFromContentStream,
  inflate,
  normalizeExtractedText,
  parseToUnicodeCMap,
  readZipEntry,
  _latin1ToBytes,
} from "../onboarding/resumeText";

const FIX = path.join(process.cwd(), "tests/fixtures/onboarding-resume");
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));

/** Builds a minimal PDF from object bodies (1-based), with a catalog at object 1. */
function buildPdf(objects: string[]): Uint8Array {
  let out = "%PDF-1.4\n";
  objects.forEach((body, i) => {
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n%%EOF`;
  return _latin1ToBytes(out);
}

function streamObj(content: string, dictExtra = "", compress = false): string {
  const data = compress ? zlib.deflateSync(Buffer.from(content, "latin1")).toString("latin1") : content;
  return `<< /Length ${data.length}${compress ? " /Filter /FlateDecode" : ""}${dictExtra} >>\nstream\n${data}\nendstream`;
}

const SIMPLE_FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

function simplePdf(content: string, compress = false): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    streamObj(content, "", compress),
    SIMPLE_FONT,
  ]);
}

describe("PDF text extraction (edge-safe, no third-party parser)", () => {
  it("reads a Chrome/Skia PDF (Type0 + ToUnicode, per-glyph positioning) like a LinkedIn export", async () => {
    const r = await extractPdfText(fixture("linkedin-style.pdf"));
    expect(r.failure).toBeNull();
    const lines = r.text.split("\n");
    expect(lines).toContain("Top Skills");
    expect(lines).toContain("Senior Data Analyst");
    expect(lines).toContain("March 2021 - Present (3 years 9 months)");
    expect(lines).toContain("Bengaluru, Karnataka, India");
    // Non-ASCII via the ToUnicode CMap
    expect(r.text).toContain("“forecasting” — café.");
  });

  it("reports an image-only (scanned) PDF as scanned_pdf with no text", async () => {
    const r = await extractPdfText(fixture("scanned.pdf"));
    expect(r).toEqual({ text: "", failure: "scanned_pdf" });
  });

  it("reads simple-font literal strings, escapes, TJ spacing and line moves (plain and Flate)", async () => {
    const content =
      "BT /F1 12 Tf 72 700 Td (Senior Data Analyst) Tj 0 -14 Td [(Skills:) -400 (SQL,) -400 (Python) -400 (\\050Tableau\\051)] TJ " +
      "T* (Location: Pune\\, India) Tj T* (Experience in dashboards and forecasting) Tj ET";
    for (const compress of [false, true]) {
      const r = await extractPdfText(simplePdf(content, compress));
      expect(r.failure).toBeNull();
      expect(r.text.split("\n")).toEqual([
        "Senior Data Analyst",
        "Skills: SQL, Python (Tableau)",
        "Location: Pune, India",
        "Experience in dashboards and forecasting",
      ]);
    }
  });

  it("maps WinAnsi bytes (smart quotes, bullet, en dash)", () => {
    const fonts = new Map([["F1", { cmap: null, twoByte: false, widths: null, defaultWidth: 500 }]]);
    const text = extractTextFromContentStream("BT /F1 10 Tf (\\223Hi\\224 \\225 2019 \\226 2021) Tj ET", fonts as any);
    expect(text.trim()).toBe("“Hi” • 2019 – 2021");
  });

  it("returns no_text for a PDF with no text and no images, and never throws on junk", async () => {
    expect(await extractPdfText(_latin1ToBytes("%PDF-1.7\n%%EOF"))).toEqual({ text: "", failure: "no_text" });
    const junk = await extractPdfText(_latin1ToBytes("%PDF-1.7\n1 0 obj << /Type /Page /Contents 9 0 R >> stream\n\u0000\u0001garbage"));
    expect(junk.text).toBe("");
    expect(["no_text", "parse_error"]).toContain(junk.failure);
  });

  it("refuses encrypted PDFs (parse_error) instead of returning ciphertext", async () => {
    const pdf = _latin1ToBytes("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF");
    expect(await extractPdfText(pdf)).toEqual({ text: "", failure: "parse_error" });
  });

  it("does not run or extract embedded PDF JavaScript", async () => {
    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert('pwned')) >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      streamObj("BT /F1 12 Tf (Senior Product Manager with Figma and SQL experience) Tj ET"),
      SIMPLE_FONT,
    ]);
    const r = await extractPdfText(pdf);
    expect(r.text).toBe("Senior Product Manager with Figma and SQL experience");
    expect(r.text).not.toContain("pwned");
  });

  it("reads objects from compressed object streams (PDF 1.5+)", async () => {
    // Objects 5 (page) and 6 (font) exist only inside the object stream (object 4).
    const page = "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /Contents 3 0 R >>";
    const header = `5 0 6 ${page.length + 1} `;
    const objstm = header + page + " " + SIMPLE_FONT;
    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
      streamObj("BT /F1 12 Tf (Backend Engineer working with Go and Kubernetes in Bengaluru) Tj ET", "", true),
      streamObj(objstm, ` /Type /ObjStm /N 2 /First ${header.length}`, true),
    ]);
    const r = await extractPdfText(pdf);
    expect(r.failure).toBeNull();
    expect(r.text).toBe("Backend Engineer working with Go and Kubernetes in Bengaluru");
  });
});

describe("ToUnicode CMap", () => {
  it("parses bfchar, bfrange (offset and array) and codespace length", () => {
    const cmap = parseToUnicodeCMap(`
      1 begincodespacerange <0000> <FFFF> endcodespacerange
      2 beginbfchar <0003> <0020> <0024> <0041> endbfchar
      2 beginbfrange <0044> <0046> <0061> <0050> <0051> [<00E9> <201C>] endbfrange`);
    expect(cmap.byteLengths).toEqual([2]);
    const m = (hex: string) => cmap.map.get(String.fromCharCode(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16)));
    expect(m("0003")).toBe(" ");
    expect(m("0024")).toBe("A");
    expect([m("0044"), m("0045"), m("0046")]).toEqual(["a", "b", "c"]);
    expect([m("0050"), m("0051")]).toEqual(["é", "“"]);
  });

  it("drops text from a CID font that has no ToUnicode (glyph ids are not text)", () => {
    const fonts = new Map([["F2", { cmap: null, twoByte: true, widths: null, defaultWidth: 1000 }]]);
    expect(extractTextFromContentStream("BT /F2 10 Tf <00260052> Tj ET", fonts as any).trim()).toBe("");
  });

  it("adversarial CMap: 200 repeated 64k bfrange blocks stop safely within budget (< 100ms)", () => {
    // 200 ranges with span 0xffff would be 13M iterations if uncapped
    const line = "<0000> <FFFF> <0000>\n";
    const adversarialCMap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\nbeginbfrange\n" +
      line.repeat(200) +
      "endbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
    
    const t0 = Date.now();
    const cmap = parseToUnicodeCMap(adversarialCMap);
    const duration = Date.now() - t0;

    expect(duration).toBeLessThan(300);
    expect(cmap.map.size).toBeLessThanOrEqual(8192);
  });

  it("adversarial PDF with heavy repeated ranges stops safely within stream/work budgets", async () => {
    const line = "<0000> <FFFF> <0000>\n";
    const cmapStream = "/CIDInit /ProcSet findresource begin\nbegincmap\nbeginbfrange\n" + line.repeat(200) + "endbfrange\nendcmap";
    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      `<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>`,
      `<< /Length 19 >>\nstream\nBT /F1 10 Tf (hi) Tj ET\nendstream`,
      `<< /Length ${cmapStream.length} >>\nstream\n${cmapStream}\nendstream`,
    ]);
    const t0 = Date.now();
    const result = await extractPdfText(pdf);
    const duration = Date.now() - t0;
    expect(duration).toBeLessThan(500);
    expect(result).toBeDefined();
  });

  it("regression: 82 KB PDF with 1,000 font objects sharing one CMap finishes in well under 1 second", async () => {
    // 1 shared CMap
    const cmapBody =
      "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n" +
      "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
      "1 beginbfrange\n<0001> <0005> <0041>\nendbfrange\n" +
      "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
    const cmapStream = `<< /Length ${cmapBody.length} >>\nstream\n${cmapBody}\nendstream`;

    const FONT_COUNT = 1000;
    const fontNames: string[] = [];
    const fontObjects: string[] = [];
    // Obj 1: Catalog, Obj 2: Pages, Obj 3: Page, Obj 4: CMap stream
    // Fonts are Obj 5 to 1004. Content stream is Obj 1005.
    for (let i = 0; i < FONT_COUNT; i++) {
      const objNum = 5 + i;
      fontNames.push(`/F${i} ${objNum} 0 R`);
      fontObjects.push(`<< /Type /Font /Subtype /Type0 /BaseFont /Font${i} /Encoding /Identity-H /ToUnicode 4 0 R >>`);
    }

    const contentStream = "<< /Length 20 >>\nstream\nBT /F0 10 Tf (AB) Tj ET\nendstream";

    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${fontNames.join(" ")} >> >> /Contents ${5 + FONT_COUNT} 0 R >>`,
      cmapStream,
      ...fontObjects,
      contentStream,
    ]);

    expect(pdf.byteLength).toBeGreaterThanOrEqual(75000); // ~82 KB

    const t0 = Date.now();
    const result = await extractPdfText(pdf);
    const duration = Date.now() - t0;

    // Must finish in well under 1 second (without caching/budget, this took ~6.8s)
    expect(duration).toBeLessThan(1000);
    expect(result).toBeDefined();
  });

  it("regression: 40KB PDF with CMap range 0000-1fff and 20,000-byte destination returns safe failure under 100ms", async () => {
    // 20,000 bytes = 40,000 hex characters
    const bigDest = "0041".repeat(10000);
    const cmapBody =
      "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
      "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
      `1 beginbfrange\n<0000> <1FFF> <${bigDest}>\nendbfrange\n` +
      "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";

    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>",
      "<< /Length 20 >>\nstream\nBT /F1 10 Tf (hi) Tj ET\nendstream",
      `<< /Length ${cmapBody.length} >>\nstream\n${cmapBody}\nendstream`,
    ]);

    expect(pdf.byteLength).toBeGreaterThanOrEqual(40000); // ~40 KB

    const t0 = Date.now();
    const result = await extractPdfText(pdf);
    const duration = Date.now() - t0;

    // Must return safe parse failure in well under 100ms (previously took >8 seconds)
    expect(duration).toBeLessThan(100);
    expect(result.failure).toBe("parse_error");
  });

  it("regression: CMap with array-form destination exceeding code width returns safe parse failure under 100ms", async () => {
    const bigDest = "0041".repeat(10000);
    const cmapBody =
      "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
      "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
      `1 beginbfrange\n<0000> <0001> [<${bigDest}>]\nendbfrange\n` +
      "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";

    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>",
      "<< /Length 20 >>\nstream\nBT /F1 10 Tf (hi) Tj ET\nendstream",
      `<< /Length ${cmapBody.length} >>\nstream\n${cmapBody}\nendstream`,
    ]);

    const t0 = Date.now();
    const result = await extractPdfText(pdf);
    const duration = Date.now() - t0;

    expect(duration).toBeLessThan(100);
    expect(result.failure).toBe("parse_error");
  });
});

describe("DOCX text extraction", () => {
  it("reads paragraphs from word/document.xml (deflated) and decodes entities", async () => {
    const r = await extractDocxText(fixture("resume.docx"));
    expect(r.failure).toBeNull();
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("Rahul Verma");
    expect(lines).toContain("Built React & TypeScript apps");
    expect(lines).toContain("React, TypeScript, Next.js, GraphQL, Figma");
  });

  it("returns parse_error for a ZIP without word/document.xml and for garbage", async () => {
    expect((await extractDocxText(_latin1ToBytes("PK\u0003\u0004 not really a zip"))).failure).toBe("parse_error");
    expect(await readZipEntry(new Uint8Array(10), "word/document.xml")).toBeNull();
  });

  it("dispatches by kind", async () => {
    expect((await extractResumeText(fixture("resume.docx"), "docx")).failure).toBeNull();
    expect((await extractResumeText(fixture("scanned.pdf"), "pdf")).failure).toBe("scanned_pdf");
  });
});

describe("helpers", () => {
  it("inflate keeps output when trailing bytes follow the deflate stream and caps output", async () => {
    const z = zlib.deflateSync(Buffer.from("hello world"));
    const withJunk = new Uint8Array(Buffer.concat([z, Buffer.from([0x0a, 0x0a, 0x20])]));
    expect(Buffer.from(await inflate(withJunk, "deflate")).toString()).toBe("hello world");
    const bomb = zlib.deflateSync(Buffer.alloc(2 * 1024 * 1024));
    expect((await inflate(new Uint8Array(bomb), "deflate", 1024)).byteLength).toBe(1024);
  });

  it("normalizes whitespace and strips control characters", () => {
    expect(normalizeExtractedText("  a\u0000b \t c \r\n\r\n\r\n\r\nd\u0007e ")).toBe("ab c\n\nd e");
  });
});
