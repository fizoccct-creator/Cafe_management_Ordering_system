---
name: figma-sync
description: Keep the CafeFlow Figma design system and the CSS in step (Dekad and Electric looks, light and dark). Use when the user changed something in Figma, changed styles.css or themes/moodboard.css, or asks to sync design and code.
---

# Figma ↔ code sync

File: https://www.figma.com/design/VPIk0WRR7gf5DUIIb6lSdN (key `VPIk0WRR7gf5DUIIb6lSdN`). Full mapping: `design/FIGMA.md`.

| Figma | Code |
|---|---|
| Color collection `VariableCollectionId:2:7`, modes Light `2:1`, Dark `2:2`, Electric Light `24:0`, Electric Dark `24:1` | `styles.css` (Dekad), `themes/moodboard.css` (Electric) |
| Layout collection `VariableCollectionId:2:8`, modes Dekad `2:3`, Electric `24:2` | `--space-*`, `--radius-*`, `--radius-control` |
| Primitives `VariableCollectionId:2:6` (hidden, aliased) | raw hex |
| Role vars `color/header/*`, `nav/*`, `bar/*`, `add/*`, `where/*`, `chip/*`, `banner/*`, `card/border` | `--header-bg`, `--nav-on-bg`, `--bar-bg`… (WEB code syntax = CSS name) |
| Pages: Components `2:3`, Staff App `2:4`, Customer App `2:5`, Electric Theme `24:791` | |

## Check first (free)

`node tools/tokens.js` — compares `design/tokens.json` with both CSS files in all four modes. Exit 1 lists differences. Run after any CSS change.

## Figma → code

1. Load the Figma skills once (figma-use; figma-generate-library for variables/components), `create_session` with the file key.
2. One read-only `use_figma` call: resolve every Color var for modes 2:1, 2:2, 24:0, 24:1 and every Layout var for 2:3, 24:2 (follow aliases; return `css|name|hex…` lines).
3. Rewrite `design/tokens.json` (colors: light/dark/electricLight/electricDark; sizes: px/electric).
4. `node tools/tokens.js --write`, then `node tools/tokens.js` must print "matches". Values set through `var()` are reported for hand edits.
5. Component/layout changes: screenshot the changed component and update the matching CSS (map in `design/FIGMA.md`).

## Code → Figma

Change the variable values in Figma for the right mode with `setValueForMode` (aliases to primitives; add a primitive under `electric/…` if a new hex is needed). New CSS role var → new Figma variable with scopes and WEB code syntax `var(--name)`, Dekad modes aliasing the general semantic var.

## Gotchas

- Rebinding inside components: skip nodes inside instances, and only rebind the root stroke for "card border" (inner divider `line` strokes must stay `color/border/default`).
- BOOLEAN variables can't take scopes (leave default).
- Each `use_figma` script is atomic: a failure rolls everything back, fix and rerun.
- `setCurrentPageAsync` once per call; return all node IDs.
