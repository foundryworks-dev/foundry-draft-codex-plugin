# Changelog

## 1.1.0 (unreleased; ships with the EP-19 rollout)

- **Craft apps (EP-19, #666).** Five new tools: `craft_tools`, `craft_open`,
  `craft_call`, `craft_save` and `craft_close`, wrapping Draft's craft
  gateway. `craft_call` passes the app's MCP result through unchanged, so a
  screenshot reaches the client as image content. A session notice (restored
  or reset) is shown first, as text.
- `SERVER_INFO` reports the release version (it had stayed at 0.8.0).
- `scripts/test-craft-tools.js`, run in CI: the craft tools against a stub
  API, over the real stdio transport.

Earlier releases predate this file; see the release tags.
