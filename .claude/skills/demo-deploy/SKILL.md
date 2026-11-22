---
name: demo-deploy
description: Rebuild the CafeFlow client demo and publish it to the Dekad demo repo (Cloudflare Pages). Use when the user asks to push/update/publish the demo, or after changes to demo.html, demo.js, the app or the Electric theme that clients should see.
---

# Publish the client demo

The demo is a static site generated from this repo. It is pushed to a **separate** repo with a **separate** GitHub account.

| What | Value |
|---|---|
| Build | `node tools/build-demo.js <outDir>` (outDir must be outside this repo) |
| Demo repo | https://github.com/dekad-teknologies/Cafe_management (branch `main`) |
| Push account | `dekad-teknologies` (saved in Git Credential Manager; this repo pushes as `fizoccct-creator`) |
| Hosting | Cloudflare Pages: preset None, build command empty, output `/` |

## Steps

1. Build into a fresh folder in the scratchpad, e.g. `<scratch>/cafeflow-demo`.
2. If that folder has no `.git` (scratchpad was cleared): clone the demo repo there first, then delete everything except `.git` and build into it:
   `git clone https://dekad-teknologies@github.com/dekad-teknologies/Cafe_management.git <dir>`
   `find <dir> -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +` then build.
3. Test locally: `python -m http.server <port>` in the folder; open `/` (tour), `/demo-app.html#pos`, `/demo-order.html?t=5`; place one guest order and confirm it reaches the staff app. Stop the server.
4. Commit in the demo folder: "… (built from CafeFlow <short sha>)" with the Co-Authored-By line, then
   `git push https://dekad-teknologies@github.com/dekad-teknologies/Cafe_management.git main`.
   Pushing needs the user's go-ahead in this conversation.
5. Confirm with `git ls-remote origin main`. Cloudflare redeploys automatically.

## Notes

- If the starting demo data changes, bump `VERSION` in `demo.js` so returning visitors start over.
- Demo opens empty (order #1 is the first one placed); "Fill with sample orders" loads a busy morning.
- Cloudflare free plan: unlimited static requests/bandwidth, 20,000 files, 25 MiB per file — the demo is ~15 small files.
- If a push says "Repository not found", the account lacks access: `git credential-manager github list`, and add an account with `git credential-manager github login` (the user signs in).
