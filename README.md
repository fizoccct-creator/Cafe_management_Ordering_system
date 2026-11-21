# CafeFlow — café ordering

Menu management, order taking, and a live kitchen/bar ticket screen. No payments.
Branded for **Dekad Teknologies** (colours, fonts and logo: see the design document, section 7a).

## Run it in the café (all devices in sync)

1. On one computer that stays on during opening hours (the "café server"), install
   [Node.js](https://nodejs.org) (LTS).
2. Copy this folder onto it and run:

   ```
   node server.js
   ```

   The window shows something like:

   ```
   Staff app, this computer:   http://localhost:8080
   Staff app, other devices:   http://192.168.1.20:8080
   Staff PIN: 123456   (change it in Settings → Staff PIN)
   ```

3. On every tablet/phone/PC **on the same Wi-Fi**, open the "other devices" address.
   - Counter tablet → **Order** tab
   - Kitchen / bar screen → **Kitchen** tab (filter by Bar or Kitchen, turn sound on)
   - Owner → **Orders** (today's numbers) and **Menu**
   - On a tablet, use the browser's *Add to Home Screen* for an app icon.
4. Enter the **Staff PIN** on each staff device (it stays signed in), then change it in
   Settings → Staff PIN. Forgot it? Stop the server, delete `data/config.json`, start again.
5. **Customer QR ordering:** Settings → QR ordering → *Table QR codes* → Print. Customers on the
   café Wi-Fi scan the code on their table, order from their phone and watch the status live.
   QR orders wait in **Orders** for staff to accept (approval can be turned off).
6. First run on Windows: allow Node.js through the firewall on **Private networks**
   when asked, otherwise other devices can't connect.

Tip: give the server computer a fixed IP in your router (DHCP reservation) so the
address never changes.

## How sync behaves

- Every change (new order, status, sold-out, menu edit) appears on all devices within a second.
- The header shows **Live · N devices**, or **Offline · N waiting** if a device loses the connection.
  Offline changes are kept on that device and sent automatically when it reconnects.
- The server numbers orders (#1, #2 … restarting each day) so two tills never clash.
- Data is saved in `data/cafeflow.json` on the server (90 days of orders).
  Use **Settings → Export backup** regularly.

## Port

Default 8080. To change: `PORT=9000 node server.js` (PowerShell: `$env:PORT=9000; node server.js`).

## Standalone mode

Opening the app without the server (e.g. any static host) runs it on one device
only, with data stored in that browser.

## Files

| File | What it is |
|---|---|
| `server.js` | Café server: serves the app, saves data, pushes live updates |
| `shared.js` | Seed menu + `applyOp`, the single function that changes data (used by app and server) |
| `app.js`, `index.html`, `styles.css` | The staff app |
| `order.html`, `customer.js` | Customer QR ordering page |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install/offline support |
