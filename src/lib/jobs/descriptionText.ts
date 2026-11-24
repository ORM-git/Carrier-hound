import { stripHtmlAndExecutableMarkup } from "@/lib/security/xss";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ensp: " ", emsp: " ", thinsp: " ", ndash: "\u2013", mdash: "\u2014",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  bull: "\u2022", middot: "\u00b7", hellip: "\u2026", copy: "\u00a9", reg: "\u00ae",
};

/** Display-only text cleanup. Never insert the result as HTML or change the stored posting. */
export function jobDescriptionText(input?: string | null): string {
  if (typeof input !== "string") return "";
  let text = input;
  // Some feeds double-escape entities. Bound the passes, then strip decoded markup too.
  for (let pass = 0; pass < 3; pass++) {
    const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
      if (!key.startsWith("#")) return ENTITIES[key.toLowerCase()] ?? entity;
      const hex = key[1]?.toLowerCase() === "x";
      const code = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(code);
    });
    if (decoded === text) break;
    text = decoded;
  }
  return stripHtmlAndExecutableMarkup(text).replace(/\u00a0/g, " ").trim();
}
