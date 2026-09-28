# Development

Use Node.js 24.14 or newer. Run `npm ci --ignore-scripts`, `npm run build:vendor`,
`npm test` and `npm run check`. The vendor bundle is checked in so end users do
not need npm. Regenerate its full dependency notices with the bundle.

`npm run test:ui` uses an installed Chromium-family browser with an isolated,
synthetic local service. It does not use an account or the real clipboard.
`npm run build:release` and `npm run test:release` build a whitelisted ZIP and
verify it in a clean folder without node_modules or account credentials.

Live tests are separate and opt-in: `npm run test:live` uses your signed-in
website account and its usage allowance. Never run live tests in public CI.
`npm run test:live:control` opens an isolated Playwright browser against the
already signed-in local service and verifies the real control page, model list,
Auto selection, refresh, and generation check. It also consumes one real probe.
Attachment checks are `node scripts/media-live-check.js` and
`node scripts/pdf-live-check.js`. `node scripts/reliability-live-check.js` checks
longer context, two simultaneous clients and cancellation after streaming begins.
They use synthetic data, still consume real account allowance, and delete only
their own stored test responses. Release gates are in `docs/release-readiness.md`.
`npm run test:live:all` runs these real-account checks sequentially, including the
control page. It is intentionally never part of CI.
`npm run test:first-run` creates an isolated temporary runtime and opens the
normal interactive sign-in. After the user completes sign-in, it automatically
starts a temporary loopback API, sends one Auto request through the Node client,
and cleans up its own server and temporary data. It still needs the user to
complete any account password or verification step.
Do not upload credentials, browser profiles, private databases, raw HTTP traces,
or account screenshots in issues or pull requests. Include sanitized error codes
and reproduction steps instead. Runtime data must remain outside this repository.

Keep unit, browser-fixture, official-SDK and live-account results distinct.
Do not advertise unsupported endpoints or substitute another model silently.
