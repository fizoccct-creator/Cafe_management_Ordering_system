# CafeFlow — café ordering

Menu management, order taking, a live kitchen/bar ticket screen, and customer ordering by
table QR code. No payments (customers pay at the counter).
Branded for **Dekad Teknologies** (colours, fonts and logo: see the design document, section 7a).

**Design:** [CafeFlow Design System in Figma](https://www.figma.com/design/VPIk0WRR7gf5DUIIb6lSdN): tokens, components and every screen.
[design/FIGMA.md](design/FIGMA.md) explains how Figma maps to the code and how to keep them in step
(`node tools/tokens.js` checks that `styles.css` matches the Figma tokens).

The same code runs two ways:

| | **Cloud** (Render + Neon) | **Café computer** |
|---|---|---|
| Customers scan QR codes from | Anywhere (mobile data or any Wi-Fi) | The café Wi-Fi only |
| Staff open the app from | Anywhere, over HTTPS (full app install) | The café Wi-Fi |
| Works if the café internet is down | No | Yes |
| Data stored in | Neon Postgres | `data/` folder on that computer |
| Cost | Free tier possible (see limits below) | Free |

---

## Cloud: deploy on Render (free) with a Neon database (free)

You need a GitHub account with this repo, plus free accounts at [neon.com](https://neon.com)
and [render.com](https://render.com).

1. **Create the database (Neon).** New project → pick the region closest to your café
   (e.g. *AWS Asia Pacific (Singapore)*). On the project dashboard click **Connect** and copy
   the connection string (`postgresql://…?sslmode=require`). Keep it secret.
2. **Create the app (Render).** Dashboard → **New → Blueprint** → connect GitHub → choose this
   repo. Render reads `render.yaml` and asks for:
   - `DATABASE_URL` → paste the Neon connection string
   - `STAFF_PIN` → choose a 4–8 digit PIN for staff
   Then **Apply**. The first deploy takes a few minutes.
   (`render.yaml` uses the Singapore region; change `region:` first if your café is elsewhere.)
3. **Open it.** Render shows your address, e.g. `https://cafeflow-xxxx.onrender.com`.
   Sign in with the staff PIN, then change it in Settings → Staff PIN.
4. **Set up the café.** Menu tab → your items and prices. Settings → café name, currency,
   number of tables.
5. **Print QR codes.** Settings → QR ordering → **Table QR codes** → Print. They point at your
   Render address, so customers can scan from their own mobile data.

Every push to `main` on GitHub redeploys automatically. Data stays in Neon.

### Free-tier limits (check the providers' pricing pages; they change)
- **Render free** sleeps after ~15 minutes with no visitors; the next visitor waits about a minute
  while it wakes (often the first customer scan of the morning). 750 free hours/month covers one
  service, 5 GB/month bandwidth. Render does not recommend free instances for production.
  To remove the sleep, change `plan: free` to `plan: starter` in `render.yaml` (paid).
- **Neon free**: 1 GB storage per project, which is plenty for menus and 90 days of orders.
  The database pauses when idle and resumes on the next request in a moment.

### Forgot the staff PIN (cloud)
Neon dashboard → **SQL Editor** → run `DELETE FROM cafeflow_kv WHERE key = 'config';` →
Render → **Manual Deploy → Restart service**. The server uses `STAFF_PIN` again (or prints a new
random PIN in the Render **Logs**). Every device must sign in again and QR codes must be reprinted.

---

## Café computer: run it on your own network

1. On one computer that stays on during opening hours, install [Node.js](https://nodejs.org) (LTS).
2. Copy this folder onto it, then run:

   ```
   npm install
   node server.js
   ```

   The window shows something like:

   ```
   Staff app, this computer:   http://localhost:8080
   Staff app, other devices:   http://192.168.1.20:8080
   Staff PIN: 123456   (change it in Settings → Staff PIN)
   ```

3. On every tablet/phone/PC **on the same Wi-Fi**, open the "other devices" address and enter the PIN.
   - Counter tablet → **Order** · Kitchen / bar screen → **Kitchen** (turn sound on) · Owner → **Orders**, **Menu**
4. First run on Windows: allow Node.js through the firewall on **Private networks**.
5. **Forgot the PIN?** Stop the server, delete `data/config.json`, start again (new PIN, reprint QR codes).

Tip: give the server computer a fixed IP in your router so the address never changes.

---

## Using it

- **QR orders** arrive in **Orders** as *Needs approval* (banner on the Order and Kitchen screens).
  Accept sends them to the kitchen; approval can be turned off in Settings → QR ordering.
- Each QR code only works for its own table. If codes were photographed or shared,
  Settings → QR ordering → **Make new QR codes** (all printed codes stop working; reprint them).
- Every change appears on all staff devices within a second. The header shows **Live · N devices**,
  or **Offline · N waiting**: offline changes are kept and sent when the connection returns.
- **Settings → Look** switches between the **Dekad** and **Electric** designs. It changes every staff
  device and the guest ordering page at once.
- **Settings → Export backup** downloads the menu and full order history. Do it regularly.

## Client demo

`demo.html` is a showcase page for clients, in the "electric" mood board style (blue, lime,
charcoal, round cards, tilted tags). From it, clients can try the real software:

| Page | What it is |
|---|---|
| `demo.html` | Tour page: live numbers, side-by-side guest phone + staff tablet (wide screens), "try it in 3 steps" |
| `demo-app.html` | The full staff app with the mood board theme |
| `demo-order.html?t=5` | The guest QR ordering page for Table 5 |

- **No server or sign-in needed.** The demo café lives in the visitor's browser, separate from real
  café data. It opens with the menu ready and **no orders**, so a walkthrough starts at order #1:
  staff take an order on the Order screen, a guest orders at Table 5, staff approve it, the kitchen
  serves both. A guest order placed in one tab shows up in the staff app in another tab.
- **Start over** empties it again; **Fill with sample orders** loads a busy morning (orders in
  every stage) for showing reports and the kitchen board.
- To host the demo on its own (e.g. Cloudflare Pages), run `node tools/build-demo.js <folder>` and
  publish that folder. No build command is needed.
- Works on any static host (e.g. GitHub Pages) and on the café server at `/demo.html`.
- Because data stays in one browser, a phone and a laptop don't share the demo. To show two
  devices together, use the server version.
- **Template, not a fork:** the demo runs the same `app.js`, `customer.js` and `styles.css`.
  The look is the Electric theme (`themes/moodboard.css`, also available to real cafés in
  Settings → Look) and the no-server behaviour comes from `demo.js`.

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. When set, data goes to Postgres instead of `data/` |
| `STAFF_PIN` | First staff PIN (4–8 digits) when none exists yet |
| `PUBLIC_URL` | Public address for QR codes. Render's `RENDER_EXTERNAL_URL` is used automatically |
| `PORT` | Port to listen on (default 8080; Render sets it) |
| `DATA_DIR` | Folder for local data files (default `./data`) |
| `TRUST_PROXY` | `1` when behind a hosting proxy (automatic on Render) |

## Standalone mode

Opening `index.html` without the server (e.g. from any static host) runs the staff app on one
device only, with data stored in that browser. QR ordering needs the server.

## Files

| File | What it is |
|---|---|
| `server.js` | Server: staff PIN, live sync, customer orders, static files |
| `storage.js` | Saves data to Postgres (`DATABASE_URL`) or to local files |
| `shared.js` | Seed menu + `applyOp`, the single function that changes data (used by app and server) |
| `app.js`, `index.html`, `styles.css` | The staff app |
| `order.html`, `customer.js` | Customer QR ordering page |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install/offline support |
| `themes/moodboard.css` | Electric look (Settings → Look) |
| `demo.html`, `demo-app.html`, `demo-order.html`, `demo.js` | Client demo (see above) |
| `render.yaml` | Render deploy blueprint |
| `package.json` | Node project; one dependency (`pg`) |
