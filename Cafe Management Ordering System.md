# Cafe Management Ordering System

**CafeFlow** is an app for café owners and staff that handles the ordering process: the menu, taking orders, getting them to the bar and kitchen, and handing them over. Payments are out of scope for this version.

| | |
|---|---|
| **Status** | Phases 1–3 done (single device, multi-device sync, customer QR ordering); cloud version ready to deploy |
| **Platform** | Installable web app (PWA) plus a small Node.js server, run on a café computer or in the cloud (Render + Neon Postgres) |
| **Dependencies** | Plain HTML, CSS and JavaScript in the browser; the server uses Node.js built-ins plus `pg` (Postgres driver) |

---

## 1. Problem and research

### 1.1 How a café order flows

```
Menu → Take order → Customise → Route to station → Prepare → Ready → Serve / Pick up → Review the day
```

### 1.2 What each stage needs

| Stage | What is needed | What usually goes wrong without it |
|---|---|---|
| **Menu** | Categories, prices, a sold-out switch that takes effect immediately | Staff take orders for items that have run out |
| **Customisation** | Size, temperature, milk, sweetness and extras (each with its own price), plus free-text notes | Options are written by hand or shouted, so drinks come out wrong |
| **Order context** | Dine-in with a table number, or takeaway with a name and order number | Orders go to the wrong table or get swapped at pickup |
| **Routing** | Drinks go to the bar, food goes to the kitchen | One paper ticket gets passed back and forth |
| **Order queue** | First in, first out, a status for each order, and how long it has been waiting | Orders get forgotten or made out of order |
| **Handoff** | A "Ready" status and order numbers that restart each day | Customers keep asking whether their order is ready |
| **Review** | Order count, best-selling items, average preparation time | No data for planning stock or staff |

### 1.3 Requirements that follow

1. Taking an order should need only a few taps, and the price should update as options are chosen.
2. The kitchen and bar should get each order instantly, with a separate view for each station.
3. A status flow everyone can see: **New → Preparing → Ready → Completed** (or **Cancelled**).
4. Visual alerts when an order has waited too long.
5. The owner can edit the menu without help from a developer.
6. The app keeps working when the internet or Wi-Fi drops.
7. It runs on the devices the café already has (tablets, phones, a PC) without app-store fees.

---

## 2. Solution

### 2.1 Approach

| Decision | Choice | Why |
|---|---|---|
| App type | **Progressive Web App (PWA)** | One codebase runs on Android, iOS/iPadOS and Windows, installs from the browser, works offline, and needs no app-store approval |
| Sync | **One small Node server, run locally or in the cloud** | Café computer: no accounts or cost, works when the internet is down. Cloud: customers scan from their own mobile data, HTTPS gives a full app install, the owner can check from anywhere |
| Cloud host | **Render (app) + Neon (Postgres)** | Both have free tiers, Render deploys straight from GitHub, and Neon keeps data permanently (Render's free disk is wiped on restart) |
| Stack | Vanilla JavaScript, Node.js built-ins, one dependency (`pg`) | No build step and almost nothing to maintain, so it is easy for one person to keep running |

### 2.2 Phased roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Order screen, kitchen display, order list and daily summary, menu management, settings, backups, installable on one device | ✅ Done |
| 2 | Multi-device live sync through a local café server, an offline queue, server-assigned order numbers | ✅ Done |
| 3 | Customer QR ordering at the table with live order status, staff approval, printable QR codes, staff PIN | ✅ Done (a "now ready" display screen is still to do) |
| 3b | Cloud version: Postgres storage, HTTPS, signed table QR codes, Render blueprint | ✅ Done (ready to deploy) |
| 4 | Payments and receipts, staff logins and roles, reports beyond today | Planned |

---

## 3. Features

### Order (counter)
- Menu grid with category filter and search; sold-out items are greyed out
- Option sheet for each item: single-choice groups (size, milk…) and pick-any groups (extras), each option with its own price, plus a note and quantity
- **Dine-in** with a table picker (tables with open orders are marked) or **Takeaway** with an optional customer name
- Order note, live total, **Send to kitchen**
- Phone layout: a floating "View order" bar opens a full-screen cart

### Kitchen display
- Three columns: **New / Preparing / Ready**, oldest order first
- Station filter: **All**, **Bar · drinks** or **Kitchen · food**
- A waiting timer on each ticket that turns **amber** and then **red** (thresholds set in Settings)
- Tap an item to tick it off; one tap moves the order to the next step, and ↩ moves it back
- Optional sound when an order arrives from another device

### Orders and today's summary
- Orders today, items made, total order value, average time to ready
- Top 5 items of the day
- Active, Completed and Cancelled lists, with cancel and restore

### Menu management
- Add, edit and delete items (name, category, price, station, option groups, available)
- Categories: add, rename, reorder, delete (only when the category has no items)
- Option groups: reusable across items, with an extra price on each option

### Customer QR ordering
- Each table has a QR code that opens `order.html?t=<table>`. A takeaway code (`?t=take`) goes at the counter
- A phone-friendly menu by category, the same option sheet as the counter, a cart, an optional note (and a name for takeaway)
- After ordering, the customer sees a large order number and live progress: **Sent → Accepted → Preparing → Ready**. Their phone vibrates when the order is ready
- "Pay at the counter": there is no payment in the app
- The customer page only uses the public `/api/public/*` endpoints and cannot reach staff data

### QR order approval (staff)
- QR orders arrive as **Needs approval**. A banner on the Order and Kitchen screens and a badge on Orders alert staff
- **Accept & send to kitchen** or **Reject** (the customer sees "cancelled"). Approval can be switched off in Settings
- QR orders carry a **QR** tag on tickets and in order lists

### Settings
- Café name, currency symbol, number of tables, alert thresholds
- Device connection addresses (in server mode)
- **QR ordering:** turn it on or off, require approval, open the printable QR sheet (3 per row when printed)
- **Staff PIN:** change it (this signs out other devices), or sign out this device
- Install the app, export and import backups, reset to the demo data

---

## 4. Architecture

### Café computer
```
            Café Wi-Fi (LAN)
 ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
 │ Counter tab. │        │ Kitchen scr. │        │ Owner phone  │
 │  (Order)     │        │  (Kitchen)   │        │ (Orders/Menu)│
 └──────┬───────┘        └──────┬───────┘        └──────┬───────┘
        │  POST /api/op          │  SSE /api/events      │
        └────────────┬───────────┴───────────┬───────────┘
                     ▼                       ▲
              ┌─────────────────────────────────────┐
              │  server.js  (Node)                   │
              │  applyOp() → version++ → broadcast   │
              │  data/cafeflow.json  (atomic write)  │
              └─────────────────────────────────────┘
```

### Cloud
```
 Customers' phones (mobile data)      Staff devices (anywhere)
   order.html?t=5&k=…                   index.html (PIN)
          │  HTTPS                          │  HTTPS + SSE
          ▼                                 ▼
   ┌──────────────────────────────────────────────┐
   │ Render web service: server.js  (same code)    │
   │ state in memory → debounced writes            │
   └───────────────────────┬──────────────────────┘
                           │ DATABASE_URL (TLS)
                   ┌───────▼────────┐
                   │ Neon Postgres  │  cafeflow_kv (menu, settings, PIN)
                   │                │  cafeflow_orders (one row per order)
                   └────────────────┘
```
The server keeps the whole state in memory, as it does locally, and writes only what changed to Postgres. One instance serves everything, which suits a single café; live updates (SSE) need all devices on the same instance.

### 4.1 Files

| File | Responsibility |
|---|---|
| `index.html` | App shell: header, navigation, dialog |
| `styles.css` | Responsive layout, light and dark themes, touch-sized controls |
| `shared.js` | Demo menu data and **`applyOp`**, the only function that changes data. The app and the server both use it |
| `app.js` | Screens, user actions, the sync client, the offline queue |
| `server.js` | Serves the app files, checks the staff PIN, receives changes, pushes live updates, handles customer orders |
| `storage.js` | Saves to Postgres when `DATABASE_URL` is set, otherwise to files in `data/` |
| `render.yaml` | Render deploy blueprint |
| `order.html`, `customer.js` | The customer QR ordering page |
| `sw.js` | Service worker that loads the network version first and falls back to the cache |
| `manifest.webmanifest`, `icons/` | What the PWA needs to be installable |

### 4.2 Two modes

| Mode | When | Where data lives |
|---|---|---|
| **Standalone** | The app is opened without the server (any static host) | That browser's `localStorage`. Tabs on the same device stay in sync |
| **Café server** | The app is opened from `node server.js` on a café computer | `data/cafeflow.json` on that computer. Every device on the Wi-Fi stays in sync live |
| **Cloud** | The app is opened from the Render address | Neon Postgres. Every device, anywhere, stays in sync live |

The app detects the mode on startup by calling `GET /api/state`.

---

## 5. Data model

```js
State {
  v: 1,
  settings:   { cafeName, currency, tables, warnMins, lateMins, qrEnabled, qrApproval, numDay, nextNum },
  categories: [ { id, name } ],
  groups:     [ { id, name, multi, options: [ { id, name, price } ] } ],
  items:      [ { id, name, catId, price, station: 'bar'|'kitchen', available, groups: [groupId] } ],
  orders:     [ {
    id, num, type: 'dine'|'take', table, customer, note,
    status: 'pending'|'new'|'prep'|'ready'|'done'|'cancelled',   // 'pending' = QR order awaiting approval
    source?: 'qr',
    createdAt, times: { new, prep, ready, done, cancelled },
    lines: [ { itemId, name, price, station, qty, note, done,
               mods: [ { group, name, price } ] } ]
  } ]
}
```

- Each order line keeps a **copy** of the item's name and prices, so later menu changes never alter past orders.
- Order numbers restart every day (`numDay`, `nextNum`).

---

## 6. Sync design

### 6.1 Operations ("ops")
Every change is an op, and every device applies ops with the same `applyOp` function:

| Op | Payload | Effect |
|---|---|---|
| `addOrder` | `order` | Adds a new order. The server assigns `num`. Applying it twice has no extra effect, because it checks `order.id` |
| `status` | `id, status` | Moves the order to that status and records the time |
| `line` | `id, i, done` | Ticks an item on an order on or off |
| `avail` | `id, available` | Switches an item between available and sold out |
| `menu` | `categories?, groups?, items?` | Replaces those lists |
| `settings` | `settings` | Merges the fields the owner can edit |
| `replace` | `state` | Restores a backup or resets to the demo data |

Every op carries an `opId` (used to drop duplicates) and an `at` time, which the server sets.

### 6.2 Protocol

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | `{ ver, now, recentOps, urls, cloud, qrKeys, state }`. `state` holds the menu, the last 36 hours of orders, and any orders still active |
| `GET /api/events` | Server-Sent Events: `hello`, `op` (with `ver`), `reload`, `presence` (number of connected devices) |
| `POST /api/op` | Sends one op and gets back `{ ok, ver, num? }` |
| `GET /api/backup` | Downloads the full state, including 90 days of orders |
| `POST /api/login` / `POST /api/logout` | Staff PIN sign-in and sign-out (cookie) |
| `POST /api/pin` | Change the staff PIN (staff only) |
| `POST /api/qr-rotate` | Make a new QR signing secret, so every printed code stops working (staff only) |
| `GET /api/public/menu?t=&k=` | Customer: café name, currency, tables, `tableOk`, categories, option groups, items (no orders) |
| `GET /healthz` | Health check for the host |
| `POST /api/public/order` | Customer: place an order `{ table, key, customer?, note?, lines: [{ itemId, qty, options: [optionId], note? }] }` |
| `GET /api/public/order/:id` | Customer: status of one order (by its long, hard-to-guess id) |

### 6.3 Consistency rules
- **The server decides the order.** Each op it applies raises `ver` by one and is sent to every device.
- **Devices check for gaps.** If a device receives `ver` other than its own `ver + 1`, it reloads the full state.
- **Changes show immediately.** What a device displays is the last state the server confirmed, plus that device's own changes the server hasn't confirmed yet.
- **Offline queue.** Unsent ops are kept in `localStorage` and retried every 3 seconds. The header shows **Offline · N waiting**.
- **Retries are safe.** The server remembers the last 300 `opId`s and ignores repeats.
- **One clock.** The server sets every timestamp, and each device adjusts for the difference between its clock and the server's, so ticket timers agree on every screen.
- **Conflicts.** Order changes are small and target one order, so they don't collide. Menu edits are last-write-wins.

### 6.4 Storage
- **Local files:** each save writes a temporary file that then replaces `data/cafeflow.json`, so a crash never leaves a half-written file.
- **Postgres:** `cafeflow_kv` holds a `meta` row (menu, settings, version) and a `config` row (PIN hash, sign-in tokens, QR secret); `cafeflow_orders` has one row per order. Each save is one transaction that writes the meta row and only the orders that changed, which keeps database traffic low on free tiers.
- Writes are debounced (200 ms) and run one at a time. A failed write is retried with back-off without losing the changes. On shutdown (Ctrl+C, or the host's SIGTERM during deploys and restarts) pending changes are written first.
- The server keeps 90 days of orders and sends devices only recent and active orders.

### 6.5 Security
- **Staff PIN.** Every staff endpoint needs the PIN. The server shows a random 6-digit PIN the first time it starts. Signing in sets an `HttpOnly`, `SameSite=Strict` cookie that lasts a year. The PIN is stored as a scrypt hash and sign-in tokens as SHA-256 hashes, in the config store (`data/config.json`, or the `config` row in Postgres). After 8 wrong tries from one IP address, sign-in is blocked for 5 minutes.
- **Customer orders are untrusted.** The server looks up every item, option and price from the menu itself and ignores any prices the phone sends. It also checks the table number, sold-out items, quantity (1–20 per line), number of lines (at most 30) and text lengths.
- **Rate limit.** One address can place at most 6 QR orders per table in 10 minutes. Counting per table means many phones sharing one mobile-network address can't block the whole café.
- **Approval.** By default a person checks each QR order before it reaches the kitchen, which stops prank orders.
- **Signed QR codes.** Each table's QR code includes a key (an HMAC of the table number with a server secret). Orders without the right key are refused, so someone who never sat at the table can't order for it, even though the cloud version is on the public internet. **Make new QR codes** replaces the secret and invalidates every printed code.
- **Cloud transport.** On HTTPS the sign-in cookie is marked `Secure` and HSTS is sent. All responses send `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`. Behind Render's proxy, client addresses come from `X-Forwarded-For`.
- **Secrets.** `DATABASE_URL` and `STAFF_PIN` are set in Render's environment, never in the repo.


---

## 7. Setup

### Cloud (Render + Neon, free tiers)
1. **Neon:** create a project in the region nearest the café, then copy the connection string from **Connect**.
2. **Render:** **New → Blueprint**, then pick this GitHub repo. Enter `DATABASE_URL` (the Neon string) and `STAFF_PIN` (4–8 digits), then **Apply**.
3. Open the `https://….onrender.com` address, sign in with the PIN and change it in Settings.
4. Set the menu, café name and number of tables, then print the table QR codes.
5. Every push to `main` redeploys automatically.

Free-tier limits: Render's free plan sleeps after about 15 idle minutes, and the next visitor waits about a minute. It has 750 hours and 5 GB of bandwidth a month, and Render does not recommend it for production. Neon's free plan has 1 GB of storage. Set `plan: starter` in `render.yaml` to keep the app awake (this costs money).

### Run at the café
1. Install [Node.js](https://nodejs.org) (LTS) on a computer that stays on during opening hours.
2. In the project folder, run:
   ```bash
   npm install
   node server.js
   ```
3. On each device on the same Wi-Fi, open the **"On other devices"** address it prints (for example `http://192.168.1.20:8080`).
4. On Windows, allow Node.js through the firewall on **Private networks** when asked.
5. Optional: reserve a fixed IP for the server computer in your router.
6. Note the **Staff PIN** printed in the server window, enter it on each staff device, then change it in Settings → Staff PIN.
7. Settings → QR ordering → **Table QR codes** → Print. Put one on each table and the takeaway code at the counter.

Custom port: `PORT=9000 node server.js` (PowerShell: `$env:PORT=9000; node server.js`).

### Suggested device roles
| Device | Screen |
|---|---|
| Counter tablet | **Order** |
| Bar or kitchen screen | **Kitchen** (station filter and sound on) |
| Owner's phone | **Orders** and **Menu** |
| Customers' phones | Scan the table QR code (cloud: from anywhere; café server: on the café Wi-Fi) |

### Development
Open `index.html` through any static server (for example `python -m http.server`) to run in standalone mode, or run `node server.js` for server mode. There is no build step.

### Suggested `.gitignore`
```
data/
node_modules/
.claude/
```

---

## 7a. Branding (Dekad Teknologies)

The app follows the Dekad brand guidelines. The full design system (variables in Light and Dark modes, text and shadow styles, 28 components and every staff and customer screen) is in the [CafeFlow Design System Figma file](https://www.figma.com/design/VPIk0WRR7gf5DUIIb6lSdN). [design/FIGMA.md](design/FIGMA.md) explains how Figma maps to the code, and `node tools/tokens.js` checks that `styles.css` matches the Figma tokens.

| Element | Value | Where it's used |
|---|---|---|
| Primary blue | `#246EB9` | Buttons, selected states, the selected table, prices, app icon background |
| Green | `#93FF96` | "Ready" and success states in dark mode, the icon's roof mark, the brand strip |
| Teal | `#16BAC5` | "New" tickets and info states, the brand strip |
| Black | `#1E1E1E` | Text colour, dark-mode background |
| Headings | Montserrat (Black / ExtraBold / Bold) | Titles, order numbers, stats |
| Body | Poppins (Regular / SemiBold) | All other text |
| Logo | `icons/logo-blue.png`, `icons/logo-white.png` | Settings → About (the white version is shown in dark mode) |
| Pattern | Circles in the brand colours | Brand strip under the header, the dots in About |

All colours are CSS variables at the top of `styles.css`, so the palette can be changed in one place. Fonts load from Google Fonts; without internet access the app falls back to the system font.

---

## 8. Known limitations

- **Café server:** the app is served over plain HTTP, so tablets get a home-screen shortcut rather than a full install with offline start-up, and customers must be on the café Wi-Fi. A page that is already open keeps working through short drops.
- **Cloud:** nothing works while the café's internet is down; a page already open queues staff changes until it reconnects. On Render's free plan the first visit after about 15 idle minutes takes roughly a minute.
- **Cloud:** the server runs as a single instance, because live updates are held in that one server's memory. That suits one café but not a chain.
- Staff share one PIN; there are no separate staff accounts or roles yet.
- The QR sheet loads its QR library from cdnjs, so the device used to print it needs internet access once.
- If two devices edit the menu at the same moment, the last save wins.
- Reporting covers only today; older orders are available through the backup export.
- No payments, receipts or printer support yet.

---

## 9. Next steps

1. **"Now ready" display**: a customer-facing screen listing order numbers that are ready.
2. **Staff roles**: separate owner and staff PINs, with Menu and Settings for the owner only.
3. **Merge a table's QR orders**: show all of a table's orders and its running bill together.
4. **Ticket printing**: ESC/POS printers at the bar and kitchen.
5. **Owner reports**: weekly and monthly sales and best-sellers, using the order history stored in the cloud.
6. **Payments and receipts.**

---

## 10. Claude Code skills (repeatable tasks)

Recurring jobs are saved as Claude Code skills in `.claude/skills/`, so they don't have to be worked out again each time. Claude Code loads them automatically in this project; you can also ask for one by name (for example "use the demo-video skill to re-render the videos").

| Skill | Use it to | Reusable files |
|---|---|---|
| `demo-video` | Re-render or vary the 60-second explainer (16:9 and 9:16 Reels) after the app or design changes | `tools/video/capture-demo.mjs`, `design/video/landscape/index.html`, `design/video/reels/index.html` |
| `demo-deploy` | Rebuild the client demo and publish it to the Dekad demo repo (Cloudflare Pages) | `tools/build-demo.js` |
| `figma-sync` | Keep Figma and the CSS in step for both looks, light and dark | `design/tokens.json`, `tools/tokens.js`, `design/FIGMA.md` |
| `launch-captions` | Write the launch post and Reels/TikTok captions in the approved wording | (templates inside the skill) |

Each skill records where things are, the exact steps, and problems already solved (for example, rendering with the installed Chrome, and Instagram's safe area for Reels).
