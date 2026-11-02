import * as React from "react";

export type CMVisualProps = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  compact?: boolean | string;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "cm-find-jobs": CMVisualProps;
      "cm-tailor-resume": CMVisualProps;
      "cm-job-matches": CMVisualProps;
    }
  }
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "cm-find-jobs": CMVisualProps;
      "cm-tailor-resume": CMVisualProps;
      "cm-job-matches": CMVisualProps;
    }
  }
}
