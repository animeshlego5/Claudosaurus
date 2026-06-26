# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`claudosaurus` is a zero-dependency Node CLI that patches a **local copy** of the installed Claude Code editor extension so its "thinking" spinner becomes a playable Chrome-style dino game. There is **no build step and no runtime dependencies** — it is plain ES2019 across two distinct execution contexts (see below). There **is** a `node:test` suite (`npm test`, dev-only, no deps).

## Commands

```bash
node cli.js install           # patch the newest extension copy found (npm run patch)
node cli.js install --all     # patch every editor copy found (npm run patch:all)
node cli.js install --dry-run # preview; change nothing (npm run patch:dry)
node cli.js uninstall         # restore from backup (npm run unpatch)
node cli.js uninstall --all   # restore every copy (npm run unpatch:all)
node cli.js status            # report which editors are found / patched / stale
npm test                      # run the node:test suite (patch pipeline + locator)
```

After patching you must **reload the editor window** (Command Palette → "Developer: Reload Window") for the webview to reload the patched bundle.

### Iterating without spending API tokens
- `start game.html` (Windows; `open`/`xdg-open` elsewhere) loads the real `ide-payload.js` in a browser with a simulated spinner row — the primary dev loop for the game itself.
- `node hang-server.js` starts a "black hole" HTTP server on :8787 that never responds; launch the editor with `ANTHROPIC_BASE_URL=http://localhost:8787` to keep the live spinner up indefinitely.
- In the webview devtools console: `window.__claudosaurus.spawnTest()` forces a fake busy spinner, `.diagnose()` reports what the detector sees, `.setAlwaysOn(true)` enables free play. Appending `?claudeRexForce=1` to the webview URL auto-spawns a test spinner. (`window.__claudeRex` also works as a backward-compat alias.)

## Architecture

Three pieces, one data flow — **locate → patch → inject**:

1. **`lib/locate.js`** — finds the extension. Scans `~/.{antigravity-ide,antigravity,vscode,vscode-insiders,vscode-oss,cursor,windsurf}/extensions` for folders matching `anthropic.claude-code-<ver>`, returns matches **newest-version-first**. The patch target is always `<ext>/webview/index.js`; the backup is that path + `.claudosaurus-bak`. Fails soft (returns `[]`) so nothing crashes when no editor is present.

2. **`lib/patch.js`** — the real install/uninstall logic. Appends `ide-payload.js` to the target wrapped in `/*__CLAUDOSAURUS_START__*/ … /*__CLAUDOSAURUS_END__*/` marker comments. **Idempotency is the key invariant:** install always reconstructs from the pristine `.bak` (creating it on first run), then strips any existing marker block before re-appending — so re-running after an extension update never stacks patches. Uninstall restores from `.bak` (deleting it), or strips the marker block if the backup is gone.

3. **`ide-payload.js`** — the **single source of truth** for the injected game. This is the one file that runs in the **browser/webview context** (not Node); everything else is Node tooling. It is injected (with the `__CLAUDOSAURUS_VERSION__` token replaced by `package.json`'s version) and is also loaded as-is by `game.html`, so it must stay self-contained vanilla JS with no imports. It:
   - Renders **hand-drawn `#`-pixel bitmaps** (`DINO_BODY`/`DINO_LEGS_*`, `CACTUS_*`, `BIRD_FRAMES`, `CLOUD` near the top) as 1px rects via `drawBitmap()`, inked in the sampled spinner colour. No image assets — strictly monochrome, nothing to load, no CSP surface.
   - Runs in the bundle's nonce-trusted context, so **no CSP changes are needed** and `extension.js` is never touched.
   - Uses a `MutationObserver` (plus a 500ms safety-net poll) on the persistent spinner row (`[class*="spinnerRow"]`). "Busy" is detected by the row *containing* `[data-permission-mode],[class*="container_"]` — that content mounts only while Claude works. When it clears, the game tears itself down.
   - Hides (does not remove) the row's real children so the bundle still owns them; samples the spinner's live color so the game is strictly monochrome and theme-matched.

`cli.js` is the entry point; `install.js`/`uninstall.js` are thin legacy wrappers over `lib/patch.js`.

## Gotchas specific to this repo

- **`ide-payload.js` is browser code, not Node.** No `require`, no Node globals — it must run identically when injected into the webview and when `<script>`-loaded by `game.html`.
- **Editing the injected payload requires re-patching** (`node cli.js install`) and reloading the window; the live webview caches the old bundle. Editing `game.html`'s copy path just needs a browser refresh.
- **Selector drift is the main maintenance risk.** If an extension update breaks detection, the selectors to adjust are `CONFIG.spinnerRowSelector` / `CONFIG.busyContentSelector` at the top of `ide-payload.js`. Set `CONFIG.debug = true` to log spinner-candidate elements while tuning.
- **Bump `version` in `package.json` only.** It is the single source of truth: `lib/patch.js` replaces the `__CLAUDOSAURUS_VERSION__` token in the payload at patch time, and `game.html` shows `"dev"`. Don't hard-code a version in `ide-payload.js`.
- `package.json` now has the real GitHub URLs pointing to `animeshlego5/Claudosaurus`.
