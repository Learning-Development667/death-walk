# Death Walk

Portrait mobile-first PWA arcade game. Vanilla HTML, CSS and JavaScript on
canvas 2D. No frameworks, no build step, no dependencies.

## Project structure

```
death-walk/
├── index.html        Structure + all CSS embedded in a <style> tag
├── CLAUDE.md         This file
├── manifest.json     PWA manifest
├── sw.js             Service worker (network-first, never cache-first)
├── js/
│   └── scripts.js    All game logic in a single IIFE
├── images/           Game art (placeholder graphics drawn on canvas for now)
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

## Rules

- Always work directly on the main branch.
- Never create feature branches or pull requests.
- Never overwrite js/config.js.
- Never delete files in the images/ folder.
- Bump the version number on every commit.
- Run `node --check` before committing.
- Delete any handover brief files before committing.

## Versioning

The version number lives in three places and must be kept in sync:

- `js/scripts.js` — the `VERSION` constant
- `sw.js` — the `CACHE_NAME` string (`death-walk-vX.Y.Z`)
- `manifest.json` — the `version` field

## Fonts

- Bebas Neue — titles and big display text
- DM Sans — body text and subtitles
- DM Mono — HUD numbers (distance, timer)
