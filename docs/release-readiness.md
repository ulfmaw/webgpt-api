# Local acceptance, 2026-09-27

A locally built ZIP is a test artifact, not by itself a release approval.

Explicit selections require the reported model to match. A requested-model echo
is not success. The two metadata fields remain separate.

Discovery now observes the Chat page's own `/backend-api/models` response and
uses enabled `versions[].intelligence_presets` with available presets and
explicitly non-Work models. Categories and raw slugs are not picker options.
The page also fetches `/backend-api/tpp/models/` for Work; that response is ignored.
There is no raw-catalog or hardcoded-model fallback. Presets preserve model and
effort. The exact list follows the signed-in account's Chat picker.
Picker membership is not proof of successful generation with that model.

Preparation interception now begins before navigation, preventing early model
preparation from escaping the requested override. Foreground login windows
explicitly restore visible bounds and maximize instead of inheriting offscreen
background geometry. Manual UI interaction is diagnostic only, not a normal
API generation requirement.

Control state fixes have regression coverage: refresh preserves dated generation
evidence, re-login invalidates old account evidence, failed candidates retain
their failure, selection and refresh cannot overlap, and a stale catalog request
cannot overwrite a newly refreshed catalog. The page displays the selected
model's evidence rather than an earlier launcher's model, clears completed login
and check notices, and shows each candidate's outcome outside the dropdown.

The current code passed 118 offline tests and the desktop/mobile
control fixture, including separate requested/reported model identities across
selection, streaming, API responses and stored-response retrieval. The explicit
catalog audit exits nonzero for any failed candidate. Clean-machine first login
and account/quota variations remain untested in this audit.

Verified on this Windows machine and existing account:

- Official SDK Responses streaming, retrieve/delete, structured parsing.
- SDK streaming function loop, with one real read of a synthetic local file.
- PNG, plain-text attachment and single-page PDF through the complete API.
- PDF initialization/model-change regression fixed; two full API reruns passed.
- Cancel during startup, subsequent generation and idle browser/profile-lock cleanup.
- Codex CLI text response. The CLI read-file check remains blocked by client policy.
- Isolated browser control-panel fixture: selection success/failure, refresh, handlers,
  responsive layout and no JavaScript errors. Clipboard is stubbed, login is synthetic.
- Preset discovery has been observed from the live Chat picker. Seeing a preset
  is not the same as a completed generation check.
- The repeatable `npm run test:live:all` gate runs all local real-account checks
  sequentially; it deliberately excludes Codex CLI's external policy test.
- `npm run test:first-run` automates the isolated first-run check after the user
  completes the normal login window; it does not copy or print credentials.
- ZIP extraction and startup without node_modules or account credentials.

Remaining release gates:

- A clean machine's first sign-in and actual downstream-workbench setup.
- Full Codex file-tool workflow in an environment where its own policy allows it.
- Account, quota and sustained-use differences. One account's result is not a
  product-wide claim.
- Cross-platform and remote CI runs, not replaced by local fixture tests.

Capability gaps remain: audio, generated image/file output, hosted/custom tools,
independent reasoning effort, remote image URLs, file IDs and other official API
endpoints. Do not label this universal or fully OpenAI-compatible. Attachment
continuations re-upload files and can consume account upload allowance.

Keep credentials, raw logs and account data outside the repository and release.
Local runtime remains under the private application-data directory; dist and .tmp
are ignored.
