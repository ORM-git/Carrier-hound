/**
 * src/lib/onboarding/step2Resume.ts
 *
 * Secure resume file validation and text extraction for Onboarding Step 2.
 * Used on Node.js runtime endpoints (/api/onboarding/resume).
 */

import { stripHtmlAndExecutableMarkup, sanitizeDownloadFilename } from "@/lib/security/xss";
import { SKILLS_TAXONOMY } from "@/lib/resume/parser";
import { inflateSync } from "zlib";

export const MAX_RESUME_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface ResumeValidationResult {
  valid: boolean;
  type?: "pdf" | "docx";
  sanitizedFilename: string;
  error?: string;
}

/**
 * Checks real file type using magic bytes, validates file size <= 5MB,
 * and ensures file extension matches actual binary content.
 */
export function validateResumeBuffer(
  buffer: Buffer | Uint8Array,
  originalFilename: string,
  declaredSize?: number
): ResumeValidationResult {
  const sanitizedFilename = sanitizeDownloadFilename(originalFilename || "resume", "resume");
  const dotParts = (originalFilename || "").split(".");
  const extension = dotParts.length > 1 ? dotParts.pop()!.toLowerCase().trim() : "";

  // 1. Extension allowlist check
  if (extension !== "pdf" && extension !== "docx") {
    return {
      valid: false,
      sanitizedFilename,
      error: "Unsupported file type. Only PDF (.pdf) and Word (.docx) documents are accepted.",
    };
  }

  // 2. Size check
  const actualSize = buffer ? buffer.byteLength : (declaredSize || 0);
  if (!actualSize || actualSize <= 0) {
    return {
      valid: false,
      sanitizedFilename,
      error: "Uploaded file is empty.",
    };
  }

  if (actualSize > MAX_RESUME_SIZE_BYTES) {
    return {
      valid: false,
      sanitizedFilename,
      error: "File size exceeds 5MB limit. Please upload a document under 5MB.",
    };
  }

  // 3. Real file type verification via magic bytes
  if (!buffer || buffer.length < 4) {
    return {
      valid: false,
      sanitizedFilename,
      error: "Corrupted or truncated file content.",
    };
  }

  // PDF Magic Bytes: %PDF (0x25, 0x50, 0x44, 0x46)
  const isPdf =
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46;

  // DOCX Magic Bytes: PK\x03\x04 (0x50, 0x4B, 0x03, 0x04)
  const isZip =
    buffer[0] === 0x50 &&
    buffer[1] === 0x4B &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04;

  if (extension === "pdf") {
    if (!isPdf) {
      return {
        valid: false,
        sanitizedFilename,
        error: "Invalid file content: The file is not a valid PDF document.",
      };
    }
    return {
      valid: true,
      type: "pdf",
      sanitizedFilename,
    };
  }

  if (extension === "docx") {
    if (!isZip) {
      return {
        valid: false,
        sanitizedFilename,
        error: "Invalid file content: The file is not a valid DOCX document.",
      };
    }

    const bufferSlice = Buffer.isBuffer(buffer)
      ? buffer.subarray(0, Math.min(buffer.length, 4096))
      : Buffer.from(buffer.subarray(0, Math.min(buffer.length, 4096)));
    const headerString = bufferSlice.toString("binary");
    const hasDocxIndicators =
      headerString.includes("[Content_Types].xml") ||
      headerString.includes("word/") ||
      headerString.includes("docProps/");

    if (!hasDocxIndicators) {
      return {
        valid: false,
        sanitizedFilename,
        error: "Invalid file content: The archive is not a valid Word (.docx) document.",
      };
    }

    return {
      valid: true,
      type: "docx",
      sanitizedFilename,
    };
  }

  return {
    valid: false,
    sanitizedFilename,
    error: "Invalid file format.",
  };
}

/**
 * Extracts plain text from a valid PDF or DOCX buffer on the server.
 */
export async function extractTextFromResumeBuffer(
  buffer: Buffer,
  type: "pdf" | "docx"
): Promise<string> {
  if (type === "docx") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      const rawText = stripHtmlAndExecutableMarkup(result.value || "");
      return rawText.trim();
    } catch (_err: any) {
      throw new Error("Unable to parse Word document text. Please ensure the document is not password-protected.");
    }
  }

  if (type === "pdf") {
    try {
      const rawPdf = buffer.toString("binary");
      const cleanedPdf = rawPdf
        .replace(/\/JavaScript\s*<<[\s\S]*?>>/gi, "")
        .replace(/\/JS\s*<<[\s\S]*?>>/gi, "")
        .replace(/\/JS\s*\([^)]*\)/gi, "")
        .replace(/\/JS\s*<[^>]*>/gi, "")
        .replace(/\/S\s*\/JavaScript\b/gi, "");

      const textMatches = cleanedPdf.match(/\(([^)]+)\)\s*(?:Tj|'|")/g) || [];
      const arrayMatches = cleanedPdf.match(/\[([^[\]]+)\]\s*TJ/gi) || [];

      const extractedPieces: string[] = [];

      for (const m of textMatches) {
        const piece = m.replace(/^\(/, "").replace(/\)\s*(?:Tj|'|")$/, "");
        if (piece.length > 0) extractedPieces.push(piece);
      }

      for (const arr of arrayMatches) {
        const innerStrings = arr.match(/\(([^)]+)\)/g) || [];
        for (const s of innerStrings) {
          const piece = s.replace(/^\(/, "").replace(/\)$/, "");
          if (piece.length > 0) extractedPieces.push(piece);
        }
      }

      let combined = extractedPieces.join(" ");

      if (combined.trim().length < 20) {
        try {
          const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
          let streamMatch: RegExpExecArray | null;
          const decompressedChunks: string[] = [];

          while ((streamMatch = streamRegex.exec(rawPdf)) !== null) {
            try {
              const rawStreamData = Buffer.from(streamMatch[1], "binary");
              const decompressed = inflateSync(rawStreamData);
              const textContent = decompressed.toString("utf8");
              const innerTextMatches = textContent.match(/\(([^)]+)\)\s*(?:Tj|'|")/g) || [];
              for (const m of innerTextMatches) {
                const piece = m.replace(/^\(/, "").replace(/\)\s*(?:Tj|'|")$/, "");
                if (piece.length > 0) decompressedChunks.push(piece);
              }
            } catch {
              // Non-flate stream or uncompressed chunk; continue
            }
          }

          if (decompressedChunks.length > 0) {
            combined = decompressedChunks.join(" ");
          }
        } catch {
          // zlib fallback
        }
      }

      const sanitized = stripHtmlAndExecutableMarkup(combined || "");
      if (sanitized.trim().length < 10) {
        return "Resume uploaded (scanned / visual layout).";
      }

      return sanitized.trim();
    } catch (_err: any) {
      throw new Error("Unable to parse PDF text. Please ensure the document is not password-protected.");
    }
  }

  throw new Error("Unsupported document type for text extraction.");
}

/**
 * Extracts recognized candidate skills deterministically from resume text.
 */
export function extractSkillsFromText(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  const lowerText = ` ${text.toLowerCase()} `;
  const detectedSkills = new Set<string>();

  for (const skill of SKILLS_TAXONOMY) {
    if (!skill || skill.length < 2) continue;
    const lowerSkill = skill.toLowerCase();
    const escaped = lowerSkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|[\\s,;:.()/\\[\\]-])${escaped}(?:$|[\\s,;:.()/\\[\\]-])`, "i");
    if (regex.test(lowerText)) {
      detectedSkills.add(skill);
    }
  }

  return Array.from(detectedSkills);
}
