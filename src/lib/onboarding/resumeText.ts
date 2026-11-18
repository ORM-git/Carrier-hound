/**
 * src/lib/onboarding/resumeText.ts
 *
 * Server-side, edge-safe text extraction for onboarding resume uploads (PDF / DOCX),
 * including LinkedIn "Save to PDF" exports. No Node APIs and no third-party parser:
 * Uint8Array + the platform DecompressionStream only, so it runs on Cloudflare Pages.
 *
 * Scope is deliberately narrow: get readable text out of text-based PDFs (simple fonts
 * and Type0/Identity-H fonts with a ToUnicode CMap) and DOCX body text. Image-only
 * (scanned) PDFs and encrypted PDFs yield no text and a reason; nothing here throws.
 */

export type ResumeTextFailure = "no_text" | "scanned_pdf" | "parse_error";

export interface ResumeTextResult {
  text: string;
  failure: ResumeTextFailure | null;
}

/** Cap on inflated bytes per stream and in total (zip-bomb guard). */
const MAX_STREAM_OUT = 8 * 1024 * 1024;
const MAX_TOTAL_OUT = 24 * 1024 * 1024;
const MAX_OBJECTS = 20000;
const MAX_TEXT_CHARS = 40000;
/** Fewer meaningful characters than this means "no usable text". */
const MIN_TEXT_CHARS = 40;

class OutputBudget {
  used = 0;
  take(n: number): boolean {
    this.used += n;
    return this.used <= MAX_TOTAL_OUT;
  }
}

/**
 * Inflates zlib ("deflate") or raw deflate data. Returns whatever was produced before
 * an error (PDF streams often carry trailing bytes after the deflate end marker).
 */
export async function inflate(
  data: Uint8Array,
  format: "deflate" | "deflate-raw",
  maxOut = MAX_STREAM_OUT
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(data as unknown as BufferSource).catch(() => {});
    writer.close().catch(() => {});
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxOut) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch {
    // keep partial output
  }
  const out = new Uint8Array(Math.min(total, maxOut));
  let off = 0;
  for (const c of chunks) {
    if (off + c.byteLength > out.length) {
      out.set(c.subarray(0, out.length - off), off);
      break;
    }
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = start; i < end; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(end, i + CHUNK))));
  }
  return s;
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Collapses whitespace per line, drops empty runs, caps length. */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function meaningfulLength(text: string): number {
  // Whitespace, ASCII punctuation, Latin-1 symbols and general punctuation do not count.
  return text.replace(/[\s!-/:-@[-`{-~ -¿ -⁯]/g, "").length;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

interface PdfObject {
  dict: string;
  stream?: Uint8Array;
}

type CMap = { map: Map<string, string>; byteLengths: number[] };

interface PdfFont {
  cmap: CMap | null;
  twoByte: boolean;
  /** Glyph widths in 1/1000 em by code; null when the font gives none. */
  widths: Map<number, number> | null;
  defaultWidth: number;
}

// WinAnsi bytes 0x80-0x9F that differ from Latin-1.
const WIN_ANSI: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†",
  0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ",
  0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•",
  0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›",
  0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function refOf(dict: string, key: string): number | null {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return m ? Number(m[1]) : null;
}

/** Extracts a balanced `<< ... >>` value that follows `/key`. */
function inlineDictOf(dict: string, key: string): string | null {
  const idx = dict.search(new RegExp(`/${key}\\s*<<`));
  if (idx < 0) return null;
  let i = dict.indexOf("<<", idx);
  let depth = 0;
  const start = i;
  while (i < dict.length) {
    if (dict.startsWith("<<", i)) {
      depth++;
      i += 2;
    } else if (dict.startsWith(">>", i)) {
      depth--;
      i += 2;
      if (depth === 0) return dict.slice(start, i);
    } else {
      i++;
    }
  }
  return null;
}

function refsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(\d+)\s+\d+\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(Number(m[1]));
  return out;
}

async function decodeStream(dict: string, raw: Uint8Array, budget: OutputBudget): Promise<Uint8Array | null> {
  const filterMatch = dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/);
  const filters = filterMatch ? filterMatch[1].match(/\/\w+/g) || [] : [];
  if (filters.length === 0) return raw;
  if (filters.length === 1 && (filters[0] === "/FlateDecode" || filters[0] === "/Fl")) {
    const out = await inflate(raw, "deflate");
    if (!budget.take(out.byteLength)) return null;
    // PNG predictors (rare in content streams) are not supported.
    if (/\/Predictor\s+(1[0-5])/.test(dict)) return null;
    return out;
  }
  return null; // images (DCT/JPX/CCITT) and anything else are skipped
}

function parseObjects(bin: string, bytes: Uint8Array): Map<number, { dict: string; streamRaw?: Uint8Array }> {
  const objects = new Map<number, { dict: string; streamRaw?: Uint8Array }>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(bin)) && count++ < MAX_OBJECTS) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endObj = bin.indexOf("endobj", bodyStart);
    const nextObj = bin.slice(bodyStart, endObj < 0 ? undefined : endObj);
    const streamKw = nextObj.search(/\bstream(\r\n|\n|\r)/);
    if (streamKw >= 0) {
      const dict = nextObj.slice(0, streamKw);
      const eol = nextObj.slice(streamKw).match(/^stream(\r\n|\n|\r)/)![0].length;
      let dataStart = bodyStart + streamKw + eol;
      const lenMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      let dataEnd = -1;
      if (lenMatch) {
        const candidate = dataStart + Number(lenMatch[1]);
        if (candidate <= bin.length && /^\s*endstream/.test(bin.slice(candidate, candidate + 20))) dataEnd = candidate;
      }
      if (dataEnd < 0) {
        dataEnd = bin.indexOf("endstream", dataStart);
        if (dataEnd < 0) continue;
        while (dataEnd > dataStart && (bin[dataEnd - 1] === "\n" || bin[dataEnd - 1] === "\r")) dataEnd--;
      }
      objects.set(num, { dict, streamRaw: bytes.subarray(dataStart, dataEnd) });
      re.lastIndex = dataEnd;
    } else {
      objects.set(num, { dict: nextObj });
      if (endObj > 0) re.lastIndex = endObj;
    }
  }
  return objects;
}

async function resolveObjects(bin: string, bytes: Uint8Array, budget: OutputBudget): Promise<Map<number, PdfObject>> {
  const parsed = parseObjects(bin, bytes);
  const out = new Map<number, PdfObject>();
  for (const [num, o] of Array.from(parsed)) {
    if (!o.streamRaw) {
      out.set(num, { dict: o.dict });
      continue;
    }
    const decoded = await decodeStream(o.dict, o.streamRaw, budget);
    out.set(num, { dict: o.dict, stream: decoded ?? undefined });
  }
  // Compressed object streams (PDF 1.5+): fonts and pages often live here.
  for (const [, o] of Array.from(out)) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1] ?? 0);
    const first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    const text = latin1(o.stream);
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n && i * 2 + 1 < header.length; i++) {
      const objNum = header[i * 2];
      const start = first + header[i * 2 + 1];
      const end = i + 1 < n ? first + header[(i + 1) * 2 + 1] : text.length;
      if (!out.has(objNum)) out.set(objNum, { dict: text.slice(start, end) });
    }
  }
  return out;
}

function hexToBytesStr(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const padded = clean.length % 2 ? clean + "0" : clean;
  let s = "";
  for (let i = 0; i < padded.length; i += 2) s += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  return s;
}

function utf16beToString(bytesStr: string): string {
  let s = "";
  for (let i = 0; i + 1 < bytesStr.length; i += 2) {
    s += String.fromCharCode((bytesStr.charCodeAt(i) << 8) | bytesStr.charCodeAt(i + 1));
  }
  return s;
}

function incrementBytes(bytesStr: string, by: number): string {
  const arr = Array.from(bytesStr, (c) => c.charCodeAt(0));
  let carry = by;
  for (let i = arr.length - 1; i >= 0 && carry > 0; i--) {
    const v = arr[i] + carry;
    arr[i] = v & 0xff;
    carry = v >> 8;
  }
  return String.fromCharCode(...arr);
}

/** Parses a ToUnicode CMap (bfchar / bfrange / codespacerange). */
export function parseToUnicodeCMap(src: string): CMap {
  const map = new Map<string, string>();
  const byteLengths = new Set<number>();
  for (const block of Array.from(src.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g))) {
    for (const h of Array.from(block[1].matchAll(/<([0-9a-fA-F\s]+)>\s*<[0-9a-fA-F\s]+>/g))) {
      byteLengths.add(Math.max(1, Math.ceil(h[1].replace(/\s/g, "").length / 2)));
    }
  }
  for (const block of Array.from(src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))) {
    for (const p of Array.from(block[1].matchAll(/<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]*)>/g))) {
      const src2 = hexToBytesStr(p[1]);
      map.set(src2, utf16beToString(hexToBytesStr(p[2])));
      byteLengths.add(src2.length);
    }
  }
  for (const block of Array.from(src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))) {
    const re = /<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>\s*(?:<([0-9a-fA-F\s]*)>|\[([^\]]*)\])/g;
    for (const r of Array.from(block[1].matchAll(re))) {
      const lo = hexToBytesStr(r[1]);
      const hi = hexToBytesStr(r[2]);
      const loN = parseInt(r[1].replace(/\s/g, ""), 16);
      const hiN = parseInt(r[2].replace(/\s/g, ""), 16);
      const span = Math.min(hiN - loN, 0xffff);
      if (!(span >= 0)) continue;
      byteLengths.add(lo.length);
      if (r[3] !== undefined) {
        const dst = hexToBytesStr(r[3]);
        for (let k = 0; k <= span; k++) {
          map.set(incrementBytes(lo, k), utf16beToString(incrementBytes(dst, k)));
        }
      } else if (r[4] !== undefined) {
        const dsts = Array.from(r[4].matchAll(/<([0-9a-fA-F\s]*)>/g)).map((d: RegExpMatchArray) => utf16beToString(hexToBytesStr(d[1])));
        for (let k = 0; k <= span && k < dsts.length; k++) map.set(incrementBytes(lo, k), dsts[k]);
      }
      void hi;
    }
  }
  return { map, byteLengths: Array.from(byteLengths).sort((a, b) => b - a) };
}

function decodeWithFont(raw: string, font: PdfFont | undefined): string {
  if (font?.cmap && font.cmap.map.size > 0) {
    const { map, byteLengths } = font.cmap;
    const lengths = byteLengths.length > 0 ? byteLengths : [font.twoByte ? 2 : 1];
    let out = "";
    let i = 0;
    while (i < raw.length) {
      let matched = false;
      for (const len of lengths) {
        const code = raw.slice(i, i + len);
        const u = map.get(code);
        if (u !== undefined) {
          out += u;
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) i += lengths[lengths.length - 1];
    }
    return out;
  }
  if (font?.twoByte) return ""; // CID font without ToUnicode: codes are glyph ids, not text
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out += WIN_ANSI[c] ?? (c >= 0x20 || c === 0x09 ? String.fromCharCode(c) : " ");
  }
  return out;
}

type Token = { t: "num"; v: number } | { t: "str"; v: string } | { t: "name"; v: string } | { t: "op"; v: string } | { t: "arr"; v: Token[] };

/** Tokenizes a content stream (strings decoded to raw byte strings). */
function tokenize(src: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  const n = src.length;
  const stack: Token[][] = [];
  const emit = (tok: Token): void => {
    if (stack.length > 0) stack[stack.length - 1].push(tok);
    else result.push(tok);
  };
  while (i < n) {
    const c = src[i];
    if (c === "%") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "(") {
      let depth = 1;
      let s = "";
      i++;
      while (i < n && depth > 0) {
        const ch = src[i];
        if (ch === "\\") {
          const nx = src[i + 1];
          if (nx === undefined) break;
          if (/[0-7]/.test(nx)) {
            let oct = nx;
            if (/[0-7]/.test(src[i + 2] || "")) oct += src[i + 2];
            if (oct.length === 2 && /[0-7]/.test(src[i + 3] || "")) oct += src[i + 3];
            s += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i += 1 + oct.length;
            continue;
          }
          const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
          if (nx === "\r") {
            i += src[i + 2] === "\n" ? 3 : 2;
            continue;
          }
          if (nx === "\n") {
            i += 2;
            continue;
          }
          s += esc[nx] ?? nx;
          i += 2;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        s += ch;
        i++;
      }
      emit({ t: "str", v: s });
    } else if (c === "<" && src[i + 1] === "<") {
      // inline dictionary (e.g. BDC properties): skip balanced
      let depth = 0;
      while (i < n) {
        if (src.startsWith("<<", i)) {
          depth++;
          i += 2;
        } else if (src.startsWith(">>", i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
    } else if (c === "<") {
      const end = src.indexOf(">", i);
      const hex = src.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
      emit({ t: "str", v: hexToBytesStr(hex) });
    } else if (c === "[") {
      stack.push([]);
      i++;
    } else if (c === "]") {
      const arr = stack.pop() || [];
      i++;
      emit({ t: "arr", v: arr });
    } else if (c === "/") {
      let j = i + 1;
      while (j < n && !/[\s/[\]()<>{}%]/.test(src[j])) j++;
      emit({ t: "name", v: src.slice(i + 1, j) });
      i = j;
    } else if (/[0-9+\-.]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      emit({ t: "num", v: Number(src.slice(i, j)) || 0 });
      i = j;
    } else {
      let j = i;
      while (j < n && !/[\s/[\]()<>{}%]/.test(src[j])) j++;
      if (j === i) j = i + 1;
      const word = src.slice(i, j);
      i = j;
      if (word === "BI") {
        // inline image: skip to EI
        const ei = src.indexOf("EI", i);
        i = ei < 0 ? n : ei + 2;
        continue;
      }
      emit({ t: "op", v: word });
    }
  }
  // Unclosed arrays at end of stream are dropped.
  return result;
}

/** Extracts text from one content stream given its font resources. */
export function extractTextFromContentStream(src: string, fonts: Map<string, PdfFont>): string {
  let out = "";
  let font: PdfFont | undefined;
  let fontSize = 10;
  let lastY: number | null = null;
  // Width of text shown since the current line origin (Td/TD/Tm/T* reset it).
  let shownSinceOrigin = 0;
  const operands: Token[] = [];
  const emitText = (raw: string) => {
    out += decodeWithFont(raw, font);
    shownSinceOrigin += advanceOf(raw, font, fontSize);
  };
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const space = () => {
    if (out && !/[\s]$/.test(out)) out += " ";
  };
  for (const tok of tokenize(src)) {
    if (tok.t !== "op") {
      operands.push(tok);
      if (operands.length > 64) operands.shift();
      continue;
    }
    const op = tok.v;
    const nums = operands.filter((o): o is { t: "num"; v: number } => o.t === "num").map((o) => o.v);
    switch (op) {
      case "Tf": {
        const name = [...operands].reverse().find((o) => o.t === "name");
        font = name ? fonts.get((name as { v: string }).v) : undefined;
        const size = nums[nums.length - 1];
        if (size !== undefined && size !== 0) fontSize = Math.abs(size);
        break;
      }
      case "Tj":
      case "'":
      case '"': {
        if (op !== "Tj") newline();
        const s = [...operands].reverse().find((o) => o.t === "str");
        if (s) emitText((s as { v: string }).v);
        break;
      }
      case "TJ": {
        const arr = [...operands].reverse().find((o) => o.t === "arr");
        if (arr && arr.t === "arr") {
          for (const el of arr.v) {
            if (el.t === "str") emitText(el.v);
            else if (el.t === "num") {
              if (el.v < -200) space();
              shownSinceOrigin -= (el.v / 1000) * fontSize;
            }
          }
        }
        break;
      }
      case "Td":
      case "TD": {
        const [tx, ty] = nums.slice(-2);
        if (ty !== undefined && Math.abs(ty) > 0.5) newline();
        else if (tx !== undefined && tx - shownSinceOrigin > fontSize * 0.15) space();
        shownSinceOrigin = 0;
        break;
      }
      case "Tm": {
        const y = nums[nums.length - 1];
        if (y !== undefined) {
          if (lastY !== null && Math.abs(y - lastY) > 0.5) newline();
          else space();
          lastY = y;
        }
        shownSinceOrigin = 0;
        break;
      }
      case "T*":
        newline();
        shownSinceOrigin = 0;
        break;
      case "ET":
        space();
        break;
      default:
        break;
    }
    operands.length = 0;
  }
  return out;
}

/** Reads an array value that is either inline (`/Key [...]`) or an indirect reference. */
function arrayOf(objects: Map<number, PdfObject>, dict: string, key: string): string | null {
  const start = dict.search(new RegExp(`/${key}\\s*\\[`));
  if (start >= 0) {
    let i = dict.indexOf("[", start);
    let depth = 0;
    const from = i;
    for (; i < dict.length; i++) {
      if (dict[i] === "[") depth++;
      else if (dict[i] === "]" && --depth === 0) return dict.slice(from + 1, i);
    }
    return null;
  }
  const ref = refOf(dict, key);
  if (ref === null) return null;
  const body = (objects.get(ref)?.dict || "").trim();
  return body.startsWith("[") ? body.slice(1, body.lastIndexOf("]")) : null;
}

function fontWidths(
  objects: Map<number, PdfObject>,
  dict: string,
  twoByte: boolean
): { widths: Map<number, number> | null; defaultWidth: number } {
  const widths = new Map<number, number>();
  if (twoByte) {
    const desc = arrayOf(objects, dict, "DescendantFonts");
    const cidRef = desc ? refsIn(desc)[0] : undefined;
    const cid = cidRef !== undefined ? objects.get(cidRef)?.dict || "" : "";
    const dw = Number(cid.match(/\/DW\s+(\d+(?:\.\d+)?)/)?.[1] ?? 1000);
    const w = arrayOf(objects, cid, "W");
    if (w) {
      // Forms: `c [w1 w2 ...]` and `cFirst cLast w`.
      const re = /(\d+)\s*\[([^\]]*)\]|(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)/g;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(w)) && guard++ < 70000) {
        if (m[1] !== undefined) {
          const first = Number(m[1]);
          m[2].trim().split(/\s+/).filter(Boolean).forEach((v, k) => widths.set(first + k, Number(v)));
        } else {
          const lo = Number(m[3]);
          const hi = Math.min(Number(m[4]), lo + 65535);
          for (let c = lo; c <= hi; c++) widths.set(c, Number(m[5]));
        }
      }
    }
    return { widths, defaultWidth: dw };
  }
  const first = Number(dict.match(/\/FirstChar\s+(\d+)/)?.[1] ?? NaN);
  const arr = arrayOf(objects, dict, "Widths");
  if (Number.isFinite(first) && arr) {
    arr.trim().split(/\s+/).filter(Boolean).forEach((v, k) => widths.set(first + k, Number(v)));
    return { widths, defaultWidth: 500 };
  }
  return { widths: null, defaultWidth: 500 };
}

/** Horizontal advance of a shown string in text-space units (ignores Tc/Tw/Tz). */
function advanceOf(raw: string, font: PdfFont | undefined, size: number): number {
  const step = font?.twoByte ? 2 : 1;
  let total = 0;
  for (let i = 0; i < raw.length; i += step) {
    const code = step === 2 ? (raw.charCodeAt(i) << 8) | (raw.charCodeAt(i + 1) || 0) : raw.charCodeAt(i);
    total += font?.widths ? font.widths.get(code) ?? font.defaultWidth : 500;
  }
  return (total / 1000) * size;
}

function fontFrom(objects: Map<number, PdfObject>, fontObjNum: number, cache: Map<number, PdfFont>): PdfFont {
  const cached = cache.get(fontObjNum);
  if (cached) return cached;
  const dict = objects.get(fontObjNum)?.dict || "";
  const twoByte = /\/Subtype\s*\/Type0/.test(dict);
  const tuRef = refOf(dict, "ToUnicode");
  let cmap: CMap | null = null;
  if (tuRef !== null) {
    const s = objects.get(tuRef)?.stream;
    if (s) cmap = parseToUnicodeCMap(latin1(s));
  }
  const { widths, defaultWidth } = fontWidths(objects, dict, twoByte);
  const f: PdfFont = { cmap, twoByte, widths, defaultWidth };
  cache.set(fontObjNum, f);
  return f;
}

function fontsForResources(objects: Map<number, PdfObject>, resources: string, cache: Map<number, PdfFont>): Map<string, PdfFont> {
  const fonts = new Map<string, PdfFont>();
  let fontDict = inlineDictOf(resources, "Font");
  if (!fontDict) {
    const ref = refOf(resources, "Font");
    if (ref !== null) fontDict = objects.get(ref)?.dict || null;
  }
  if (!fontDict) return fonts;
  for (const m of Array.from(fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g))) {
    fonts.set(m[1], fontFrom(objects, Number(m[2]), cache));
  }
  return fonts;
}

function resourcesOf(objects: Map<number, PdfObject>, pageDict: string): string {
  let dict = pageDict;
  for (let depth = 0; depth < 12; depth++) {
    const inline = inlineDictOf(dict, "Resources");
    if (inline) return inline;
    const ref = refOf(dict, "Resources");
    if (ref !== null) return objects.get(ref)?.dict || "";
    const parent = refOf(dict, "Parent");
    if (parent === null) return "";
    dict = objects.get(parent)?.dict || "";
  }
  return "";
}

function pageOrder(objects: Map<number, PdfObject>, bin: string): number[] {
  const rootMatches = Array.from(bin.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g));
  const pages: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number) => {
    if (seen.has(num) || depth > 32 || pages.length > 500) return;
    seen.add(num);
    const dict = objects.get(num)?.dict || "";
    if (/\/Type\s*\/Pages\b/.test(dict)) {
      const kids = dict.match(/\/Kids\s*\[([^\]]*)\]/);
      for (const k of refsIn(kids ? kids[1] : "")) walk(k, depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(dict)) {
      pages.push(num);
    }
  };
  for (let i = rootMatches.length - 1; i >= 0 && pages.length === 0; i--) {
    const catalog = objects.get(Number(rootMatches[i][1]))?.dict || "";
    const pagesRef = refOf(catalog, "Pages");
    if (pagesRef !== null) walk(pagesRef, 0);
  }
  if (pages.length === 0) {
    for (const [num, o] of Array.from(objects)) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(num);
  }
  return pages;
}

export async function extractPdfText(bytes: Uint8Array): Promise<ResumeTextResult> {
  try {
    const bin = latin1(bytes);
    if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(bin) || /\/Encrypt\s*<</.test(bin)) {
      return { text: "", failure: "parse_error" };
    }
    const budget = new OutputBudget();
    const objects = await resolveObjects(bin, bytes, budget);
    const fontCache = new Map<number, PdfFont>();
    const parts: string[] = [];

    for (const pageNum of pageOrder(objects, bin)) {
      const pageDict = objects.get(pageNum)?.dict || "";
      const fonts = fontsForResources(objects, resourcesOf(objects, pageDict), fontCache);
      const contentsArr = pageDict.match(/\/Contents\s*\[([^\]]*)\]/);
      const contentRefs = contentsArr ? refsIn(contentsArr[1]) : [refOf(pageDict, "Contents")].filter((x): x is number => x !== null);
      // Content arrays are one logical stream split in pieces.
      const src = contentRefs.map((r) => {
        const s = objects.get(r)?.stream;
        return s ? latin1(s) : "";
      }).join("\n");
      parts.push(extractTextFromContentStream(src, fonts));

      // Text inside Form XObjects referenced by the page (one level).
      const resources = resourcesOf(objects, pageDict);
      let xo = inlineDictOf(resources, "XObject");
      if (!xo) {
        const ref = refOf(resources, "XObject");
        if (ref !== null) xo = objects.get(ref)?.dict || null;
      }
      if (xo) {
        for (const m of Array.from(xo.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g))) {
          const form = objects.get(Number(m[2]));
          if (!form?.stream || !/\/Subtype\s*\/Form/.test(form.dict)) continue;
          if (!new RegExp(`/${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+Do\\b`).test(src)) continue;
          const formRes = inlineDictOf(form.dict, "Resources") || (refOf(form.dict, "Resources") !== null ? objects.get(refOf(form.dict, "Resources")!)?.dict || "" : "");
          const formFonts = formRes ? fontsForResources(objects, formRes, fontCache) : fonts;
          parts.push(extractTextFromContentStream(latin1(form.stream), formFonts));
        }
      }
      parts.push("\n");
    }

    const text = normalizeExtractedText(parts.join("\n"));
    if (meaningfulLength(text) >= MIN_TEXT_CHARS) return { text, failure: null };
    const hasImages = Array.from(objects.values()).some((o) => /\/Subtype\s*\/Image/.test(o.dict));
    return { text: "", failure: hasImages ? "scanned_pdf" : "no_text" };
  } catch {
    return { text: "", failure: "parse_error" };
  }
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
}

/** Reads one entry from a ZIP archive via its central directory. */
export async function readZipEntry(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  for (let e = 0; e < entries && p + 46 <= bytes.length; e++) {
    if (u32(bytes, p) !== 0x02014b50) return null;
    const method = u16(bytes, p + 10);
    const compSize = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOff = u32(bytes, p + 42);
    const entryName = latin1(bytes, p + 46, p + 46 + nameLen);
    if (entryName === name) {
      if (u32(bytes, localOff) !== 0x04034b50) return null;
      const dataStart = localOff + 30 + u16(bytes, localOff + 26) + u16(bytes, localOff + 28);
      const data = bytes.subarray(dataStart, Math.min(bytes.length, dataStart + compSize));
      if (method === 0) return data;
      if (method === 8) return inflate(data, "deflate-raw");
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

export function docxXmlToText(xml: string): string {
  const text = xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeXmlEntities(text);
}

export async function extractDocxText(bytes: Uint8Array): Promise<ResumeTextResult> {
  try {
    const entry = await readZipEntry(bytes, "word/document.xml");
    if (!entry || entry.byteLength === 0) return { text: "", failure: "parse_error" };
    const xml = new TextDecoder("utf-8").decode(entry);
    const text = normalizeExtractedText(docxXmlToText(xml));
    if (meaningfulLength(text) >= MIN_TEXT_CHARS) return { text, failure: null };
    return { text: "", failure: "no_text" };
  } catch {
    return { text: "", failure: "parse_error" };
  }
}

/** Entry point. Never throws. */
export async function extractResumeText(bytes: Uint8Array, kind: "pdf" | "docx"): Promise<ResumeTextResult> {
  return kind === "pdf" ? extractPdfText(bytes) : extractDocxText(bytes);
}

/** Test helper: latin1 string -> bytes. */
export const _latin1ToBytes = latin1ToBytes;
