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

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const trimmed = line.trim();

    // 1. img / Image without alt
    if ((trimmed.startsWith("<img") || trimmed.startsWith("<Image") || trimmed.includes("<img ") || trimmed.includes("<Image ")) && !trimmed.includes("alt=") && !trimmed.includes("alt =")) {
      // Check multi-line tags if alt is on next lines
      const slice = lines.slice(idx, idx + 6).join(" ");
      if (!slice.includes("alt=") && !slice.includes("alt =")) {
        hits.imgWithoutAlt.push(`${relPath}:${lineNum} -> ${trimmed.slice(0, 80)}`);
      }
    }

    // 2. onClick on div/span without role="button"
    if ((trimmed.includes("<div") || trimmed.includes("<span")) && trimmed.includes("onClick=")) {
      const slice = lines.slice(idx, idx + 5).join(" ");
      if (!slice.includes("role=") && !slice.includes("role =")) {
        hits.onClickOnDivSpan.push(`${relPath}:${lineNum} -> ${trimmed.slice(0, 80)}`);
      }
    }

    // 3. input without aria-label or id (or label wrap)
    if (trimmed.includes("<input") && !trimmed.includes('type="hidden"') && !trimmed.includes("type='hidden'")) {
      const slice = lines.slice(Math.max(0, idx - 2), idx + 5).join(" ");
      if (!slice.includes("aria-label") && !slice.includes("id=") && !slice.includes("<label") && !slice.includes("aria-labelledby")) {
        hits.inputWithoutLabel.push(`${relPath}:${lineNum} -> ${trimmed.slice(0, 80)}`);
      }
    }

    // 4. button without text or aria-label
    if (trimmed.includes("<button")) {
      const slice = lines.slice(idx, idx + 4).join(" ");
      if (!slice.includes("aria-label") && !slice.includes("title=") && !slice.includes("<span") && !slice.includes("sr-only")) {
        if (slice.includes("/>") || slice.includes("<svg") || slice.includes("<Lucide")) {
          hits.buttonWithoutAccessibleName.push(`${relPath}:${lineNum} -> ${trimmed.slice(0, 80)}`);
        }
      }
    }
  });
}

console.log("===============================================================================");
console.log("                        STATIC ACCESSIBILITY (a11y) AUDIT                     ");
console.log("===============================================================================");
console.log(`\nSUMMARY COUNTS:`);
console.log(`- Images without alt attribute:          ${hits.imgWithoutAlt.length}`);
console.log(`- onClick on <div> or <span>:            ${hits.onClickOnDivSpan.length}`);
console.log(`- Inputs without accessible label/id:    ${hits.inputWithoutLabel.length}`);
console.log(`- Buttons without accessible name:       ${hits.buttonWithoutAccessibleName.length}`);

console.log(`\nFIRST 20 HITS:`);
const allHits = [
  ...hits.imgWithoutAlt.map(h => `[IMG-NO-ALT] ${h}`),
  ...hits.onClickOnDivSpan.map(h => `[ONCLICK-DIV/SPAN] ${h}`),
  ...hits.inputWithoutLabel.map(h => `[INPUT-NO-LABEL] ${h}`),
  ...hits.buttonWithoutAccessibleName.map(h => `[BUTTON-NO-NAME] ${h}`)
];

allHits.slice(0, 20).forEach((hit, i) => {
  console.log(`${String(i + 1).padStart(2, "0")}. ${hit}`);
});
console.log("===============================================================================");
