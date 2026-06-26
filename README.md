# Claudosaurus 🦖

![Claudosaurus Gameplay](screenshot.png)

Turn Claude Code's idle wait into play time. While Claude is working, the "thinking" spinner in the chat panel becomes a playable, monochrome, Chrome-style dinosaur game — drawn in your editor's own spinner colour so it matches the theme.

This patches the **Claude Code extension webview** (the chat panel UI) in any editor that ships it (Antigravity, VS Code, VS Code Insiders, Cursor, Windsurf). It is a lightweight, zero-dependency tool.

> **Note:** This patches your local Claude Code extension's `webview/index.js`. A backup (`.claudosaurus-bak`) is created automatically, so uninstalling restores the original exactly.

---

## Features

* **Hand-drawn monochrome art** — T-Rex, cacti, pterodactyl and cloud are pixel bitmaps drawn in your editor's sampled spinner colour, so the game stays strictly monochrome and theme-matched. No image assets — nothing to load, no CSP surface.
* **Pause, don't reset** — when Claude stops mid-turn (a permission prompt, a popup stealing focus, a gap between tool calls) the game freezes and keeps your score, then resumes the same run.
* **Obstacles** — cacti, plus pterodactyls past a score threshold. High birds fly over a grounded dino (so sometimes the right move is to *do nothing*); low/mid birds must be jumped.
* **In-game settings** — click **⚙ settings** (top-left of the game) for a panel with theme, speed/jump presets, fine-tune sliders, sound, day/night cycle, clouds, birds and free-play. Everything persists locally.
* **Lifetime stats** — games played, jumps, and total distance.

---

## Controls

* **Jump / Start / Restart**: `Space`, `↑`, or **left-click** / **tap** on the game.
* **Settings**: press `?` to toggle; `Esc` to close.

---

## Installation

### Option 1: npm (recommended)
Run it directly with `npx` (no clone needed):
```bash
npx claudosaurus
```
Or install globally:
```bash
npm install -g claudosaurus
claudosaurus
```

### Option 2: local clone (for edits & development)
```bash
git clone https://github.com/animeshlego5/Claudosaurus.git
cd Claudosaurus
node cli.js install
```

*After installing, reload your editor window (Command Palette → **Developer: Reload Window**) to apply the patch.*

---

## Commands

These work with both `claudosaurus` (npm) and `node cli.js` (clone):

| Command | What it does |
| --- | --- |
| `claudosaurus` / `install` | Patch the newest Claude Code extension found |
| `claudosaurus uninstall` | Restore the original bundle from backup |
| `claudosaurus status` | Show which editors are found, and whether each is patched (and with which version) |

Options: `--all` (apply to **every** editor copy found), `--dry-run` (preview, change nothing).

> The patch is replaced whenever the Claude Code extension updates — just run `claudosaurus` again. `claudosaurus status` will flag a patch that's older than the installed CLI version.

---

## Customising the game

The quickest way is the in-game settings panel (press `?`). Everything there also has a console API on `window.__claudosaurus` (open the webview devtools):

```js
// Presets
__claudosaurus.setSpeed("slow" | "normal" | "fast")
__claudosaurus.setJump("floaty" | "normal" | "snappy")
__claudosaurus.setTheme("auto" | "day" | "night")

// Toggles
__claudosaurus.setScanlines(true)
__claudosaurus.setSound(true)
__claudosaurus.setDayNight(true)        // invert the scene every cycleScore points
__claudosaurus.setAlwaysOn(true)        // free play even when Claude is idle

// Fine-tune any individual knob (persists, applies live)
__claudosaurus.setOptions({ startSpeed: 6, maxSpeed: 16, acceleration: 0.003,
                            gravity: 0.6, jumpVelocity: -9, birdMinScore: 100,
                            clouds: true, enableBirds: true })

// Stats & reset
__claudosaurus.stats()                  // { games, jumps, distance }
__claudosaurus.resetOptions()           // back to defaults
```

To change the **shipped defaults** in a fork, edit the `CONFIG` block and the `TUNABLES`/preset tables at the top of [`ide-payload.js`](ide-payload.js), then re-patch (`node cli.js install`) and reload.

---

## Troubleshooting

**The dino doesn't appear.** Reload the editor window after patching. If it still doesn't show, open the webview devtools console and run `__claudosaurus.diagnose()` — it prints what the detector sees (matching rows, busy state, etc.).

**Space / ↑ / `?` don't work.** The chat input holds the keyboard, so keys only reach the game once it has focus — **click the game once**, then Space, ↑ and `?` work. (Mouse/tap always works.)

**An extension update broke detection.** Re-run `claudosaurus` to re-apply the patch to the new version. If detection is still off because the extension changed its markup, you can self-heal without editing code:
```js
__claudosaurus.setSelectors({ spinnerRow: '[class*="spinnerRow"]', busyContent: '...' })
__claudosaurus.resetSelectors()   // undo
```

---

## Development & offline testing

**Standalone browser harness** — play and develop with zero API tokens:
```bash
# Windows: start game.html   ·   macOS: open game.html   ·   Linux: xdg-open game.html
```
It loads the exact `ide-payload.js` that gets injected and simulates the spinner row, with buttons to spawn/clear the spinner, fake a permission prompt, and toggle options.

**Live editor spinner test** — keep a real spinner up indefinitely:
```bash
node hang-server.js                          # a "black hole" server on :8787
ANTHROPIC_BASE_URL=http://localhost:8787 code .
```

**Tests** — zero-dependency `node:test` suite covering the patch pipeline and locator:
```bash
npm test
```

---

## Credits & license

Claudosaurus is MIT licensed — see [LICENSE](LICENSE). All game art is original hand-drawn pixel bitmaps; no third-party assets are embedded.
