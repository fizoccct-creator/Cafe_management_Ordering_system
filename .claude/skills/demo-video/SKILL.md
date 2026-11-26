---
name: demo-video
description: Make or update the CafeFlow demo explainer videos (60s, 16:9 and 9:16 Reels) with OpenMontage + HyperFrames, from real demo screenshots. Use when the user asks for the demo video, a re-render after app/design changes, a new aspect ratio, or a variant of the explainer.
---

# CafeFlow demo explainer video

Two finished videos exist. Reuse them; do not redesign from scratch unless asked.

| What | Where |
|---|---|
| OpenMontage install (own `.venv`) | `C:\Users\USER\Documents\OpenMontage` |
| Project workspace + approved artifacts | `OpenMontage\projects\cafeflow-demo-explainer\` (`artifacts\`, `checkpoint_*.json`) |
| 16:9 composition (source of truth in repo) | `design/video/landscape/index.html` → workspace `hyperframes\` |
| 9:16 Reels composition | `design/video/reels/index.html` → workspace `hyperframes-9x16\` |
| Screenshot capture script | `tools/video/capture-demo.mjs` |
| Outputs | `renders\final.mp4` (1920x1080), `renders\final_reels_9x16.mp4` (1080x1920) |
| Backlot board | `.venv\Scripts\python.exe -m backlot open cafeflow-demo-explainer` → http://127.0.0.1:4750 |

Note: the videos were made before the unslop redesign, so they show the previous Electric look (charcoal header, lime nav). Re-capture and re-render to show the current design.

Approved choices (decision_log): concept A "From #1 to Served", runtime **HyperFrames**, atelier composition, **no voice, no music** (text-led), Electric mood-board palette (blue #1F5EFF, lime #C5FF6A, ink #24252C, fog #E4E4EB; Montserrat + Poppins). 12 scenes, 60s; script in `artifacts\script.json`, scenes in `artifacts\scene_plan.json`.

## Fast path: re-render after the app changed

1. Serve the repo: `python -m http.server 8096 --bind 127.0.0.1` (background), then
   `node tools/video/capture-demo.mjs "<workspace>/assets/ui"` for **each** workspace (`hyperframes`, `hyperframes-9x16`), or capture once and copy. Stop the server after.
2. If button positions moved, read `assets/ui/coords.json` and update the `.tap` positions in the compositions:
   16:9 tablet screen is 1120 wide → scale 0.875; 9:16 tablet 920 → 0.71875; phones: 16:9 380/390, Reels 370/390 (scene 7). Tap = rect centre × scale.
3. Copy `design/video/*/index.html` into the workspaces if they were edited in the repo (or the other way round — keep them identical).
4. Check, then render (from `OpenMontage`, with its venv):
   ```
   .venv\Scripts\python.exe -c "from tools.tool_registry import registry; registry.discover(); r=registry._tools['hyperframes_compose'].execute({'operation':'check','workspace_path':'projects/cafeflow-demo-explainer/hyperframes'}); print(r.success, r.error)"
   ```
   Render: same call with `'operation':'render_existing','output_path':'projects/cafeflow-demo-explainer/renders/final.mp4','quality':'standard','fps':30` and env `HYPERFRAMES_BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`. Run it in the background (about 6 minutes per video).
5. Verify: `ffprobe` (60.0s, right size), then a frame sheet `ffmpeg -i X.mp4 -vf "fps=1/5,scale=480:-1,tile=4x3" -frames:v 1 sheet.jpg` and look at it. Send with SendUserFile.

Before rendering, eyeball frames: `npx hyperframes snapshot --at 3.5,10.2,15,22.8,26,29.8,34.4,38.6,43.5,51.5,58 --no-end -o ../renders/snaps` inside the workspace.

## Gotchas already solved (don't rediscover)

- **Render fails "Chrome not found"** (bundled headless-shell unzip breaks on Windows): set `HYPERFRAMES_BROWSER_PATH` to installed Chrome. Same runtime, not a swap.
- **Lint error `gsap_css_transform_conflict`**: never put `transform` in CSS on an element GSAP moves; set the start with `tl.fromTo(el,{x:-1920},{x:-1920,duration:0.01},0)`.
- Clips must be direct children of the root, `class="clip"` + `data-start/duration/track-index`; one paused timeline at `window.__timelines["main"]`; no `<br>`, no `repeat:-1`.
- Kitchen screen re-renders every 15s: capture ticket crops by querying `.ticket` at capture time (script does this).
- Hide `.demo-bar` in captures; remove `.qr-url` from the QR card (local address must not appear).
- **Reels clear band** (HyperFrames safe-zone table): keep everything important within y 270–1248, x 65–1015 of 1080x1920. Bottom third stays empty on purpose (Instagram caption/buttons).
- Passing ~50 lines of Python/JSON through bash heredocs breaks on quotes; write a `.py` in the scratchpad and run it.
- Artifact schemas are strict (`additionalProperties:false`): research credibility enum is `primary_source|secondary_source|anecdotal`; misconceptions are `{myth, reality}`; proposal stage tools are objects `{tool_name, role, available}`; decision options are `{option_id, label, score, reason}`.
- Gated stages (proposal, script, scene_plan, assets) need the user's approval: write `awaiting_human`, stop the turn, then `completed` with `human_approved=True`.

## New variant (other ratio, language, café)

Copy the closest composition, keep the 12-scene timing, re-lay out positions only. For a different café, capture against that café's demo data. Square 1:1 = 1080x1080: reuse the Reels layout with smaller devices. Add a `render_report` output entry for each new file.
