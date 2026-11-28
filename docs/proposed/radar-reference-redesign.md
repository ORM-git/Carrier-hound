# Radar visual redesign

Scope: close layout and interaction match to WorldStartupMap using CareerMonke jobs, existing CM shell and access gates. No funding dataset, sponsor cards, tile provider, API key or new paid service.

- Large pale globe, light-gray frame, search, jobs/country/city totals, black/cream city discs.
- Search covers city name, country code and the telemetry city's observed top-company labels. It is not a global company database search or a claim of exact office coordinates.
- List exposes all matching cities. Globe overlap handling hides lower-priority discs without adding another city's jobs to a clickable city. Edge/control occlusion hides whole markers.
- Flat map uses the same geography, scrollable viewport, zoom and collision avoidance. All locations remain accessible in List.
- Filters moved to a desktop popover/mobile scroll sheet; counts remain all active jobs, while category/remote/internship/verified filters affect the existing selected-city query. That boundary is stated in the sheet.
- Existing live telemetry, public jobs query, Pro unlock, tracker and apply handling stay in place. The Radar route still requires authenticated, confirmed Pro access and removes the globe on downgrade. One pre-existing Free drawer salary blur now uses a static placeholder rather than a real salary string.

The new earth-radar-light.jpg is generated from the repository's public/data/ne_110m_land.json polygons (Natural Earth), not copied from the reference. Land is cream, water blue-gray. No new map service.

## Validation

- Focused Vitest: radarView, existing fibonacci land dots, Radar page access. 19 assertions pass.
- TypeScript noEmit passes. ESLint has zero errors; legacy component warnings remain.
- Local real Chrome/SwiftShader preview with full existing LoggedInAppShell, repository radar fixture, explicit mocked auth/transport, a populated fixture job and mocked Pro unlock. No preview route or auth bypass is shipped.
- Desktop 1440x980 and phone 390x844: globe, search/list, selected-city drawer, close, country filter, zoom and flat/globe toggle pass without page errors.
- 390x480: filter sheet scrollHeight451/clientHeight358 with 24px bottom padding; last control reachable by internal scroll. Pro Apply opens the exact fixture destination in a new tab; Free has no application href, real salary text or match badge. This does not prove production data or deployment.

Release still needs independent source review, fresh published-head/CI checks and canonical careermonke.com/radar desktop/mobile visual verification. The author does not merge.
