# Changelog

All notable changes to Claudosaurus are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.10.0]

### Added
- **Richer hand-drawn art.** Dino, cacti, pterodactyl and cloud are `#`-pixel
  bitmaps rendered as 1px rects in the sampled spinner colour — strictly
  monochrome, theme-matched, with no image assets to load and no CSP surface.
- **In-game fine-tune sliders** for every difficulty knob (start/max speed,
  ramp, gravity, jump power, bird threshold), alongside the speed/jump presets.
- **More settings toggles**: sound, day/night cycle, clouds, birds, and free-play.
- **Optional sound FX** (jump / milestone / game-over) via WebAudio — off by default.
- **Day/night cycle** that inverts the scene every `cycleScore` points, plus a
  "+100" milestone flash.
- **Lifetime stats** — games played, jumps, and total distance — shown in the
  settings panel (`__claudosaurus.stats()`).
- **`claudosaurus status`** command: lists editors found and whether each is
  patched (and with which version, flagging stale patches).
- **Selector self-heal**: `setSelectors()` / `resetSelectors()` to fix detection
  drift after an extension update without re-patching or editing code.
- **Test suite** (`npm test`, zero new deps) covering the patch pipeline
  (backup, idempotency, version stamping, restore) and the locator.
- **CI** running tests on Node 18/20/22.

### Changed
- The version is now single-sourced from `package.json` and stamped into the
  payload at patch time (no more hand-syncing the version in two places).
- Expanded CLI help and a roomier in-game settings panel.

## [0.9.1] and earlier
- Initial public releases: spinner hijack, pause-don't-reset behaviour,
  permission-prompt detection, hand-drawn monochrome sprites, theme matching,
  and the speed/jump/theme/scanlines settings.

[0.10.0]: https://github.com/animeshlego5/Claudosaurus/releases
