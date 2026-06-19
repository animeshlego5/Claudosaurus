# 🦖 Claude-Rex

Turn Claude Code's idle wait into play time. While Claude is working, the little
"thinking" spinner in the chat panel is replaced — **inline, in place** — with a
playable, monochrome, Chrome-style dinosaur game. When Claude finishes, the game
disappears on its own.

This build targets the **Claude Code extension webview** (the chat panel UI),
which is how the editor renders the spinner. It works in any editor that ships
that extension — **Antigravity**, VS Code, VS Code Insiders, Cursor, Windsurf.

> Heads-up: this modifies your *local copy* of the Claude Code extension's
> `webview/index.js`. It's fully reversible (a timestamp-free `.bak` is kept),
> but see [Caveats](#caveats) before running it.

---

## How it works

The Claude Code chat panel is a VS Code **webview**. Its UI bundle
(`webview/index.js`) renders a "working" row (CSS class `spinnerRow_…`) that
mounts only while Claude is busy — and that row also holds the permission /
interrupt controls.

Claude-Rex appends a small vanilla-JS payload to the **end** of that bundle:

- It runs in the same nonce-trusted context as the bundle, so **no CSP changes
  are needed** (nothing in `extension.js` is touched either).
- A `MutationObserver` watches the persistent spinner row. The row is empty when
  idle and fills with a `data-permission-mode` container (the spinner + verb)
  while Claude works — so the payload keys on **that content** to know when to
  drop in a `<canvas>` dino game, drawn in the spinner's own sampled color.
- When the row's content clears (Claude is done), the game tears itself down.
- Opt-in free play: `window.__claudeRex.setAlwaysOn(true)` keeps the dino up
  even when idle.

Everything is drawn in the spinner's color, so it stays strictly monochrome and
matches your theme.

### Files

| File | Role |
|---|---|
| `cli.js` | The `claude-rex` command (install / uninstall / --all / --dry-run). |
| `ide-payload.js` | The injected game + spinner-hijack glue (single source of truth). |
| `lib/patch.js` | Backup + idempotent inject/restore logic. |
| `lib/locate.js` | Cross-editor / cross-platform extension finder. |
| `game.html` | Standalone browser harness — develop & play with **zero tokens**. |
| `install.js` / `uninstall.js` | Thin wrappers over `lib/patch.js` (legacy entry points). |

---

## Play it right now (no install, no tokens)

```bash
# from this folder, just open the harness in a browser:
#   Windows
start game.html
#   macOS
open game.html
#   Linux
xdg-open game.html
```

Click **Spawn spinner** to simulate Claude working, then jump with **Space** /
**↑** / click. Click **Remove spinner** to confirm the game self-destructs.
This loads the exact payload that gets injected, so it's a faithful preview.

---

## Install — one command

Anyone can install with **npx** — no clone, no global install:

```bash
npx claude-rex            # patch the newest Claude Code extension
npx claude-rex --all      # patch every editor copy found
npx claude-rex --dry-run  # preview only, change nothing
npx claude-rex uninstall  # restore the original
```

Or install the command globally:

```bash
npm install -g claude-rex
claude-rex                # patch
claude-rex uninstall      # revert
```

From a local clone, the equivalent dev commands are `node cli.js install`
(the legacy `node install.js` / `node uninstall.js` still work too).

Then **reload your editor** so the patched bundle loads:

- Command Palette → **Developer: Reload Window** (or close/reopen the Claude panel).

Now ask Claude anything — the working spinner becomes the dino. 🦖

Install is **idempotent**: re-running it (or running after an extension update)
always rebuilds from the pristine `.bak`, so patches never stack.

## Uninstall

```bash
npx claude-rex uninstall        # revert the newest extension
npx claude-rex uninstall --all  # revert every copy
```

It restores `webview/index.js` from the `.claude-rex-bak` backup and deletes the
backup. If the backup is missing for some reason, it strips just the injected
marker block instead. Reload the window afterward.

---

## Testing the live spinner cheaply

The game shows whenever the spinner row exists. Two zero-cost ways to see it
without burning API tokens:

1. **`game.html`** — the fully offline path above. Best for iterating on the game.
2. **"Black hole" base URL** — point Claude at a local server that accepts the
   request and never responds, so the spinner stays up indefinitely:

   ```js
   // hang-server.js — responds to nothing, keeps the spinner spinning
   require("http").createServer(function (req, res) {
     // swallow the request body, then never end the response
     req.resume();
   }).listen(8787, () => console.log("black hole on http://localhost:8787"));
   ```

   ```bash
   node hang-server.js
   # then launch your editor with the API pointed at it:
   ANTHROPIC_BASE_URL=http://localhost:8787 <your-editor>
   ```

   Send a message; Claude will appear to "work" forever (until you hit the
   interrupt control, which Claude-Rex keeps visible) — plenty of time to play.

   You can also force the game on for debugging by appending `?claudeRexForce=1`
   to a webview URL, or by running `window.__claudeRex.spawnTest()` in the
   webview devtools console.

---

## Caveats

- **Updates wipe the patch.** When the Claude Code extension auto-updates, it
  installs a fresh `webview/index.js` in a new version folder. Just run
  `npx claude-rex` again.
- **Reload required.** The webview caches the old bundle until you reload the
  panel / window.
- **It modifies a local copy of Anthropic's extension.** That's a personal mod
  on your own machine; it is fully reversible via the backup. Don't redistribute
  the patched bundle.
- **Selector drift.** The hijack keys off the stable `spinnerRow` class *prefix*
  plus the rendered busy content (not minified internals), so it survives most
  updates. If a future build changes those, edit `CONFIG.spinnerRowSelector` /
  `CONFIG.busyContentSelector` at the top of `ide-payload.js` and re-patch.

---

## Tuning

All the knobs live at the top of `ide-payload.js`:

```js
var CONFIG = {
  spinnerRowSelector: '[class*="spinnerRow"]',                 // the row to hijack
  busyContentSelector: '[data-permission-mode],[class*="container_"]', // "busy" marker
  gameHeight: 100,                                             // px strip height
  minWidth: 200,                                               // px min play width
  hiScoreKey: "claudeRexHiScore",                              // localStorage key
  alwaysOn: false                                              // free-play toggle
};
```

High score persists per webview via `localStorage`. Toggle free play at runtime
with `window.__claudeRex.setAlwaysOn(true)`.

---

## Publishing (maintainers)

The package is plain Node — no build step. To ship it so others can `npx claude-rex`:

1. **Pick a name.** Check availability: `npm view claude-rex`. If it's taken,
   either choose another name or scope it to your account in `package.json`
   (`"name": "@your-username/claude-rex"`).
2. **Set the repo URLs** in `package.json` (`repository`, `bugs`, `homepage`) —
   replace `YOUR_GITHUB_USERNAME`.
3. **Preview the contents:** `npm pack --dry-run` (should list ~11 files, no
   `node_modules` or backups).
4. **Log in & publish:**
   ```bash
   npm login
   npm publish                 # unscoped name
   npm publish --access public # if you scoped it to @your-username/...
   ```
   Bump `version` before each subsequent publish (npm rejects re-publishing the
   same version).
5. Users then run **`npx claude-rex`** — done.

**No npm account?** Push to GitHub and people can run it straight from the repo:

```bash
npx github:your-username/claude-rex
```

> Note: there is no `postinstall` hook — installing the package never patches
> anything automatically. The user must run `claude-rex` explicitly.
