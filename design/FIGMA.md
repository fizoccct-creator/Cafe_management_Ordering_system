# CafeFlow in Figma

**File:** [CafeFlow Design System](https://www.figma.com/design/VPIk0WRR7gf5DUIIb6lSdN)

| Page | What's on it |
|---|---|
| [Cover](https://www.figma.com/design/VPIk0WRR7gf5DUIIb6lSdN?node-id=20-2) | Title page in Dekad branding |
| [Foundations](https://www.figma.com/design/VPIk0WRR7gf5DUIIb6lSdN?node-id=19-2) | Colour (Light + Dark), typography, spacing, radius and shadows |
| Components | 28 components and component sets, all bound to variables (list below) |
| Staff App | Order, Kitchen, Orders/approvals, Menu, Settings, Sign-in, Table QR codes (desktop 1280), Order + Kitchen (phone 375), Order in Dark mode |
| Customer App | Menu, Item options, Your order, Order sent, Order ready, Expired QR code (phone 375), plus Dark mode examples |
| [Electric Theme](https://www.figma.com/design/VPIk0WRR7gf5DUIIb6lSdN?node-id=24-791) | Every staff and customer screen in the Electric look (from the client mood board), plus Electric Dark examples |
| [Demo, unslopped](https://www.figma.com/design/VPIk0WRR7gf5DUIIb6lSdN?node-id=32-2) | Redesign of the demo with the unslop method (Figma only, not in code yet): components kit, staff Order / Kitchen / Orders, guest Menu / Order status, demo tour hero |

## How Figma maps to the code

**Variables → CSS custom properties.** Each Figma variable has its CSS name set as code syntax, so Dev Mode shows `var(--accent)` and so on. `design/tokens.json` holds the same values, exported from Figma.

| Figma collection | Modes | CSS |
|---|---|---|
| Color (`color/bg/page`, `color/accent/default`, `color/status/ok`…) | Light, Dark, Electric Light, Electric Dark | `--bg`, `--accent`, `--ok`… Light/Dark in `styles.css` (Dark = the `prefers-color-scheme: dark` block); Electric in `themes/moodboard.css` |
| Color roles (`color/header/*`, `color/nav/*`, `color/bar/*`, `color/add/*`, `color/where/*`, `color/chip/*`, `color/banner/*`, `color/card/border`) | same four | `--header-bg`, `--nav-on-bg`, `--bar-bg`… In Dekad they point at the general colours; Electric gives them their own |
| Layout (`space/*`, `radius/*`, `radius/control`, `show/brand-stripe`) | Dekad, Electric | `--space-*`, `--radius-*`, `--radius`, `--radius-control` (buttons, segmented control, banner) |
| Primitives (raw hex) | Value | Hidden in Figma pickers; the semantic colours point to them |
| Text styles (`Heading/H2`, `Body/Default`…) | — | Montserrat for headings, Poppins for text (`--font-head`, `--font-body`) |
| Effect styles (`Shadow/Card`, `Shadow/Floating`, `Shadow/Dialog`) | — | `--shadow`, `.cartbar`, `dialog` shadows |

**Components → code**

| Figma component | Code |
|---|---|
| Button (Primary, Secondary, Ghost, Danger, Danger ghost × Medium/Small) | `.btn`, `.btn.primary`, `.btn.ghost`, `.btn.danger`, `.btn.sm` |
| Chip | `.chip`, `.chip.on` |
| Status pill | `.pill.s-new`, `.s-prep`, `.s-ready`, `.s-cancelled`, `.pill.qr` |
| Badge · Sync pill · Banner | `.badge` · `#sync` / `.sync.off` · `.banner` |
| Text field · Segment / Segmented control | `.input` · `.seg button.on` |
| Option pill · Qty stepper · Table button · Switch | `.opt` · `.qty` / `.qty.big` · `.tbl.on` / `.tbl.busy` · `.switch` |
| Nav tab · App header · Bottom nav | `.nav a.on` · `header.top` · `.nav` on phones |
| Menu item card · Order line · Kitchen ticket · Stat tile | `.item` · `.line` · `.ticket.warn` / `.ticket.late` · `.stat` |
| Customer header · Customer menu row · Cart bar · Step / Progress steps · QR card | `.c-top` / `.c-where` · `.c-item` · `.c-bar` / `.cartbar` · `.c-steps` · `.qrcard` |
| Logo · App icon | `icons/logo-*.png` · `icons/icon-*.png` |

## Themes (Dekad and Electric)

The app has two looks, chosen in **Settings → Look** and shared by every device and the guest page.
In Figma they are variable modes, not separate components, so a component change shows up in both.

| Look | Figma modes | Code |
|---|---|---|
| Dekad | Color **Light** / **Dark**, Layout **Dekad** | `styles.css` |
| Electric | Color **Electric Light** / **Electric Dark**, Layout **Electric** | `themes/moodboard.css`, active when `<html data-theme="electric">` |

To see any frame in the other look, select it and change its **Color** and **Layout** variable modes.
A third look would be one more pair of modes here and one more file in `themes/`.

## Keeping Figma and the code in step

Figma and the code don't sync on their own. Live, automatic sync would need Figma's Variables REST API and Code Connect, which require an Organization or Enterprise plan. Instead, changes go through one of the paths below. **Tokens are the source of truth.**

### A change made in Figma → the app
1. Edit the variable in Figma (for example `color/accent/default`, or a spacing or radius value), or edit a component.
2. Ask Claude Code: *"Sync the CafeFlow Figma changes into the code."* It will:
   - read the Figma variables and update `design/tokens.json`,
   - run `node tools/tokens.js --write`, which copies the new values into `styles.css`,
   - for component or layout changes, read the changed component or screen and update the matching CSS or markup,
   - check the app in the browser, then commit.

### A change made in the code → Figma
1. Change `styles.css` (or a screen).
2. Run `node tools/tokens.js`. It lists every token that no longer matches Figma.
3. Ask Claude Code: *"Update the CafeFlow Figma file to match the code."* It updates the variables, components or screens in Figma, so every instance follows.

### Checking
```bash
node tools/tokens.js
```
This checks both looks (Dekad in `styles.css`, Electric in `themes/moodboard.css`, light and dark) and prints `The CSS matches the Figma tokens` when they agree. Otherwise it lists each difference and exits with code 1, so it can also run in CI.

## Conventions in the file
- Screens are built only from component instances; colours, spacing and radius are bound to variables.
- To preview dark mode, select a frame and set its **Color** variable mode to **Dark** (see the "(Dark mode)" frames).
- The QR card shows a sample pattern; the app draws the real, signed QR code for each table.

## Demo, unslopped (redesign, not in code yet)

Made with the unslop skill. Direction: *brisk, friendly, exact*; world = a café counter mid-morning (paper tickets, the kitchen rail, receipt paper).

- **Colours:** its own variable collection **Counter** (`counter/*`, code syntax `--c-*`): warm receipt-paper neutrals, electric blue as the only accent, lime only for Ready/Served.
- **Type:** Montserrat Medium/SemiBold for titles, Poppins Regular/Medium for text, **IBM Plex Mono** for order numbers, prices and times. No 800/900 weights, no uppercase labels, no italic.
- **Components (on that page):** `Icon/*` (lucide, 18px, 1.5 stroke), `Button` (Primary/Secondary × Md/Sm), `Order stub` (signature: tear-off ticket stub, S/L), `Kitchen ticket` (New/Preparing/Ready, paper ticket on a rail with a torn edge), `Staff top bar` (Active = Order/Kitchen/Orders).
- To ship it, the CSS needs the `--c-*` tokens, the icon set in place of emoji, and the ticket/stub styles; the existing Dekad and Electric pages are unchanged.
