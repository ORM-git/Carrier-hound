import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Token-aware class merger for design-system primitives.
 *
 * The default `cn` (src/lib/utils.ts) uses stock tailwind-merge, which does not
 * know our custom `tk-*` keys and would treat e.g. `text-tk-body` as a text
 * COLOR, silently dropping it when combined with `text-ink`. This instance
 * registers the token keys in their correct class groups.
 */
const twMergeTokens = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["tk-display", "tk-h1", "tk-h2", "tk-h3", "tk-body", "tk-body-sm", "tk-caption"] }],
      shadow: [{ shadow: ["tk-xs", "tk-sm", "tk-md", "tk-lg", "tk-xl", "tk-focus"] }],
      rounded: [{ rounded: ["tk-xs", "tk-sm", "tk-md", "tk-lg", "tk-xl", "tk-2xl", "tk-full"] }],
      z: [{ z: ["tk-base", "tk-raised", "tk-sticky", "tk-header", "tk-dropdown", "tk-overlay", "tk-modal", "tk-toast"] }],
      duration: [{ duration: ["tk-fast", "tk-base", "tk-slow"] }],
      ease: [{ ease: ["tk-entrance", "tk-exit", "tk-standard"] }],
    },
  },
});

export function cnTokens(...inputs: ClassValue[]) {
  return twMergeTokens(clsx(inputs));
}
