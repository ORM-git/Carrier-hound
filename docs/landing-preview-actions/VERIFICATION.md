# Landing preview actions

Both blue Apply controls are native links to /jobs, the same href as View Jobs. The example cards do not submit applications and do not open a synthetic employer site. Header text is now Sign up for free; signup destination remains /signup. No pricing/auth behavior changed.

Top-fold runtime audit, 43-negative-control parity test and TypeScript pass. Browser fixture imports the actual HomePage, checks both link hrefs and clicks the first Apply at 390/1440 to confirm navigation to /jobs. Screenshots inspected at both widths. Fixture stubs the Next font module, so system sans-serif is used rather than production Jakarta. Production content and logo rendered. No production writes, no merge.
