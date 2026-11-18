/**
 * src/lib/onboarding/step2Resume.ts
 *
 * Edge-safe helpers for the onboarding resume upload (validation and storage; parsing lives in resumeParse.ts).
 * No Node Buffer / fs: Web streams and Uint8Array only, so it runs on Cloudflare Pages.
 */

export const RESUME_BUCKET = "resumes";
export const MAX_RESUME_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
// Multipart framing (boundaries, part headers, filename) on top of the file itself.
export const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const RESUME_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export type ResumeKind = keyof typeof RESUME_MIME;

export class BodyTooLargeError extends Error {}

/**
 * Reads a request body but stops (and cancels the stream) as soon as it exceeds maxBytes,
 * so an oversized upload is rejected before it is fully buffered. Rejects early on a
 * Content-Length that is already over the cap.
 */
export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError();
  }
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const n = Array.from(needle, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (bytes[i + j] !== n[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Real file type from magic bytes: %PDF- for PDF; a ZIP holding word/document.xml for DOCX. */
export function sniffResumeKind(bytes: Uint8Array): ResumeKind | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && containsAscii(bytes, "word/document.xml")) return "docx";
  return null;
}

export interface ResumeValidation {
  ok: boolean;
  kind?: ResumeKind;
  error?: string;
}

/** Declared MIME, extension and magic bytes must all agree on PDF or DOCX; size 1 byte..5 MB. */
export function validateResumeFile(bytes: Uint8Array, declaredMime: string, fileName: string): ResumeValidation {
  if (bytes.byteLength === 0) return { ok: false, error: "That file is empty." };
  if (bytes.byteLength > MAX_RESUME_SIZE_BYTES) return { ok: false, error: "Resume must be 5 MB or smaller." };

  const ext = fileName.toLowerCase().split(".").pop();
  const kindFromExt: ResumeKind | null = ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : null;
  if (!kindFromExt) return { ok: false, error: "Please upload a PDF or DOCX file." };
  if (declaredMime !== RESUME_MIME[kindFromExt]) {
    return { ok: false, error: "Please upload a PDF or DOCX file." };
  }
  const sniffed = sniffResumeKind(bytes);
  if (sniffed !== kindFromExt) {
    return { ok: false, error: "That file's contents don't match a PDF or DOCX." };
  }
  return { ok: true, kind: sniffed };
}

/** Display-only name: strip any path, control chars and odd characters; cap at 120 chars. */
export function sanitizeResumeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "resume";
  const cleaned = base.replace(/[^\w.\- ()]/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "resume").slice(0, 120);
}

/** Per-user private folder; random object name so user input never becomes a storage key. */
export function buildResumeStoragePath(userId: string, kind: ResumeKind): string {
  return `${userId}/onboarding/${crypto.randomUUID()}.${kind}`;
}
