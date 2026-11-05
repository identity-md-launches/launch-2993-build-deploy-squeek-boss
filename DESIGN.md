# Squeek Boss Raid design

## Overview

Squeek Boss Raid is a community game and OBS companion built around a measured-work boss fight.
The existing dark arcade system uses a colored boss illustration, a health bar and a lime action
button as its visual hierarchy. Live wheel readings stay beside the boss; role choice and joining
follow immediately. This revision preserves that composition and the existing wallet flow.

Canonical styles are in `src/assets/styles.css`; markup is in `src/index.html`, and state rendering
is in `src/assets/app.js`. All assets are local. There is no component framework or font service.

## Colors

These are the implemented `:root` tokens, in their original hex notation:

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0b0d17` | Page background, field background |
| `--surface` | `#141828` | Panels, boss surface, wallet sheet |
| `--surface-2` | `#1c2136` | Neutral buttons, selected roles, banner |
| `--surface-3` | `#262c46` | Hover surfaces, track backgrounds |
| `--line` | `#2f3758` | Control borders and pressed neutral buttons |
| `--text` | `#eef1ff` | Main text |
| `--muted` | `#a3abcc` | Descriptions and secondary labels |
| `--accent` | `#b8ff3c` | Primary actions, selected role, active wheel, current round |
| `--accent-hover` | `#ccff70` | Primary hover, link hover |
| `--accent-press` | `#ddff9c` | Primary press |
| `--on-accent` | `#0b0d17` | Text on primary actions |
| `--hp` | `#ff4d6d` | Health fill and round damage |
| `--hp-2` | `#ff8a3c` | Health gradient endpoint |
| `--amber` | `#ffc23c` | Idle wheel, unknown/stale freshness, errors and banner border |
| `--focus` | `#eef1ff` | Keyboard focus outline |

Wheel and freshness states always have a text label as well as a color. The boss SVG uses a
season-derived hue, separate from the interface status tokens. The OBS card uses
`rgb(11 13 23 / 0.86)` over a transparent page. Contrast over arbitrary stream footage is not
certified; the validation record distinguishes the measured opaque page from that overlay.

## Typography

`--font` uses `system-ui`, `-apple-system`, Segoe UI, Roboto, Helvetica Neue, Arial and sans-serif.
`--mono` uses `ui-monospace`, SFMono-Regular, Menlo, Consolas and monospace. No font files or
dependencies are needed. The CSS requests weights 400, 600 and 800; actual faces depend on the OS.

| Token | Value at a 16px root | Role |
| --- | --- | --- |
| `--fs-xs` | `0.8125rem` / 13px | Hints, stat labels, role details, feed time |
| `--fs-sm` | `0.9375rem` / 15px | Buttons, descriptions, live numbers, lists |
| `--fs-md` | `1.0625rem` / 17px | Body, primary action, sheet title |
| `--fs-lg` | `1.375rem` / 22px | Section titles, boss title |
| `--fs-xl` | `1.875rem` / 30px | Joined player's score |
| `--fs-display` | `clamp(1.875rem, 1rem + 2.5vw, 2.75rem)` / 30–44px | Main heading |

Body line height is 1.5. Headings use 1.1/1.25, weight 800 and balanced wrapping; the main heading
has `-0.02em` tracking. Role descriptions use 1.35. `.num` uses tabular monospace digits for clocks,
health, speed and scores. Intro copy is limited to 60ch, and explanation copy to 68ch. Stats allow
long values to wrap. Existing leaderboard rows shorten wallet addresses and ellipsize their label.

## Layout

The spacing tokens are 4, 8, 12, 16, 24 and 32px (`--space-1` through `--space-6`). The page is
centered at a maximum 1200px including its padding. Phone padding is at least 16px and accounts
for inline safe areas; panels use 24px vertically and 16px horizontally. The main grid gap is 24px.

| Width | Implemented behavior |
| --- | --- |
| Below 360px | Role choices stack; boss artwork column is 72px |
| 360–639px | Three role choices; boss artwork column is 96px; stats form two columns |
| 640px and above | 24px page/panel padding; four stat columns; 140px boss art; wallet sheet centers |
| 960px and above | Main grid becomes `1.5fr 1fr`; boss spans two rows on the left, join and board on the right; 200px boss art |

The header wraps when its brand and wallet action do not fit on one row. At 390px the product,
boss and header connect action are visible on the first screen. Sections retain their semantic
order as the layout expands. At narrow widths, OBS data rows wrap whole values when their combined
width does not fit; the added measurement age stays readable. Chromium reflow was checked at
320, 390 and 1440px, including stale data in both game and overlay modes.

## Elevation & Depth

The interface is flat: tonal surfaces and control borders, with no box shadows. Panels do not
have decorative borders. The modal uses the native dialog top layer and a
`rgb(5 6 12 / 0.72)` backdrop. The overlay card is translucent; the surrounding page is transparent.

## Shapes

`--radius` is 14px for panels, boss and overlay; `--radius-sm` is 10px for buttons, roles and
fields. Health and damage tracks have pill ends. The banner uses a 4px radius and a 4px warning
border. The phone wallet sheet rounds its top corners; above 640px all four corners round.

## Components

| Pattern | Source and classes | Behavior |
| --- | --- | --- |
| Actions | `styles.css`: `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-wide` | 44px minimum target; wide actions 48px; hover/press/focus/disabled states; primary press moves 1px |
| Boss | `index.html`: `.boss`, `.hp`; `app.js`: `bossSvg`, `render`, `hit` | Named health progressbar, numeric health, hit shake and defeated state |
| Live stats | `index.html`: `.stats`; `app.js`: `render`; `raid.js`: `parseStatus`, `freshness` | Active/Idle/Unknown, rpm, round and measurement age; unavailable status pauses damage and shows a banner |
| Roles | `index.html`: `.roles`, `.role` | Native labeled radio inputs; selected border/text and visible keyboard focus |
| Join / cheer | `app.js`: `join`, `renderJoin`, `doCheer` | Wallet signature pending and rejection states; joined score and multiplier; cheer cooldown; boss-down state |
| Wallet sheet | `index.html`: native `dialog`; `wallet.js`; `app.js`: `renderSheet` | Named wallet rows; pending/error note; Escape, close button and backdrop dismissal; native modal focus handling |
| Lists | `styles.css`: `.board`, `.rounds`, `.feed` | Local leaderboard with explicit empty state; round damage bars; timestamped raid events |
| Overlay link | `index.html`: `.copy-row`, `.field`; `app.js`: `init` | Readonly labeled URL; clipboard success or text-selection fallback |
| OBS | `index.html`: `.overlay`, `.o-card`, `.o-row` | `?mode=overlay` hides the game; transparent background; same status/freshness model and local board |

Focus uses a 2px `--focus` outline with 2px offset, including a ring on the selected role's label.
Reduced-motion CSS disables animation and transition duration and removes the defeated rotation.
Hit animation is finite (320ms); damage text is finite (900ms). There is no perpetual animation.

Share assets are `src/favicon.svg`, editable `src/og.svg`, and its 1200×630 raster export
`src/og.png`. Open Graph and X metadata reference `./og.png`. All are copied into `dist/`.

## Do's and Don'ts

- Reuse the existing tokens, `.layout`, `.panel`, button variants and labeled native inputs.
- Use the lime filled action for joining or cheering; keep peer utilities neutral.
- Keep wheel state and measurement freshness visible as text, including unavailable states.
- Let added data wrap rather than shrinking text or clipping values.
- Add a future section with a named `h2` inside a `.panel` and the existing 12px internal gap.
  Check it at 320, 390 and desktop widths, then rebuild the relative static export.
- Preserve the browser-local leaderboard disclosure and the transparent overlay background.

Design guidance: Jakub Krehel's Better Interface (MIT); documentation method: Paul Bakaus's
Impeccable (Apache-2.0). See `artifacts/design-guidance-LICENSE.txt` for the supplied license notices.
