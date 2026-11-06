# Browser support matrix

CareerMonke targets modern evergreen browsers. The build has no legacy
transpilation targets configured, so support follows what Next.js 14 +
Tailwind ship by default.

## Supported

| Browser | Minimum version | Notes |
| --- | --- | --- |
| Chrome / Edge (Chromium) | Last 2 major versions | Primary development target |
| Firefox | Last 2 major versions | Verified via CI lint/build; manual spot checks |
| Safari (macOS) | Last 2 major versions | WebGL globe requires WebGL2 |
| Safari (iOS) | Last 2 major versions | Safe-area insets handled via `viewportFit: "cover"` |
| Chrome (Android) | Last 2 major versions | |

## Not supported

- Internet Explorer (any version)
- Browsers without JavaScript (the app requires JS; a `<noscript>` notice is shown)
- Very old WebView / embedded browsers lacking ES2020 support

## Feature-specific notes

- `/radar` 3D globe: requires WebGL; a `checkWebGLSupport()` guard degrades gracefully.
- Service worker / offline page: progressive enhancement; the site works fully without it.
- `prefers-reduced-motion` is respected by animated components.
