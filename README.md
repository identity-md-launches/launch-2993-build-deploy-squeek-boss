# Squeek Boss Raid

A community boss raid and stream companion for [Squeekchain Genesis Code](https://squeekchain.com/genesis/code).
The boss loses health only when Squeektoshi's wheel does real, measured work on Squeekchain.
Players join free with a wallet message signature, pick a role, cheer for score boosts, and climb
the season leaderboard. `?mode=overlay` gives an OBS-ready overlay.

## Genesis blurb

> Squeek Boss Raid turns Squeektoshi's real wheel work into a live community boss fight. Every
> hour a new boss appears, and its health drops only when Squeekchain's measured work units rise.
> Join free with a wallet signature, pick Tank, Runner or Cheerleader, cheer for boosts, and add the
> transparent overlay to your stream.

The same text is in `artifacts/genesis-blurb.md`.

## How the game works

- **Season:** one UTC hour, split into six 600-second rounds. Each season has its own boss.
- **Live data:** the page polls `https://api.squeekchain.com/v1/status` about every 2 seconds.
  It sends `If-None-Match` with the last `ETag`. If the API refuses that header in a CORS
  preflight, it falls back to `cache: "no-cache"`, so the browser revalidates with its own cached
  ETag. A 304 keeps the last body. It shows the wheel state (Active / Idle), the RPM
  (`rpmMilli / 1000`), the round number, and how fresh the round data is.
- **Unknown is not zero:** if the API fails, or the last good answer is more than 10 seconds old,
  state and RPM read "Unknown", a banner says damage is paused, and nothing is credited.
- **Boss damage (formula):**

  ```
  damage(season) = sum over consecutive successful readings i of max(0, W[i] - W[i-1])
  W = cumulativeWorkUnits, and W[i-1] must have been read in the same season as W[i]
  boss health left = max(0, HP - damage(season))
  ```

  A drop in the counter (a reset), a missing field or an unavailable status adds nothing. The
  next reading becomes the new baseline. Readings from an earlier season never count toward the
  current boss. Damage made while no tab was open is credited in the same season once the page
  sees it, assigned to the round in which it was seen.
- **Boss health:** 500 for a browser's first season. After that it is 115% of the previous
  season's damage (minimum 100), so the boss tracks the wheel's real pace. `?hp=1234` overrides
  it for a stream.
- **Joining:** connect a wallet and sign a plain-text message (EIP-191 `personal_sign`) that
  names the season, role, address and a random nonce. No gas, no transaction, no chain switch.
  The signature is stored locally with the player record.
- **Points:** each credited damage unit pays every raider who joined before it was measured:
  `points += damage × role multiplier × (1 + 0.1 × active cheer stacks)`.
  - Tank: 1.0×, cheer stacks last 60 s (5 max).
  - Runner: 1.5× while the wheel is Active at 30+ rpm, otherwise 1.0× (5 stacks, 30 s).
  - Cheerleader: 0.8×, up to 10 stacks of 30 s.
  - Cheer: one stack per press, 3-second cooldown.
- **Leaderboard:** local to the browser (localStorage). Several wallets can join on one device,
  for example a stream host's machine. Other tabs on the same site share the state through the
  `storage` event, so the same work is not credited twice.

### Optional Sepolia Ping SQK

Not implemented. The brief allows `approve(self, 0)` only for the address published in the
official docs' `sepolia.json`. That file could not be read from this build machine (the docs host
answered 403), and a guessed address is not acceptable, so the game has no transaction feature.

## Install, preview and rebuild

Requires Node 20 or newer. The project has no runtime or build dependencies.

```sh
npm install        # nothing to download; keeps package-lock.json in sync
npm run build      # copies src/ to dist/ and runs the export checks
npm run check      # dist/ matches src/, relative URLs resolve, share tags exist
npm test           # node:test suite for the game rules (tests/raid.test.mjs)
npm run typecheck  # tsc --noEmit over the JSDoc-typed modules (fetches TypeScript via npx)
npm run preview    # serves dist/ at http://localhost:4173/preview/
```

Then open `http://localhost:4173/preview/` for the game and
`http://localhost:4173/preview/?mode=overlay` for the overlay.

`dist/` is the committed static export: `index.html` loads `./assets/styles.css` and
`./assets/app.js` by relative URL, so it works at any subpath, IPFS gateway or ENS name. There is
one page and no client routes. Edit files in `src/`, then run `npm run build`.

### OBS

Add a Browser source with the link from the "Stream overlay" panel (`…/?mode=overlay`), about
460 × 300. The page background is transparent. Boss health and wheel data are computed from the
live API in OBS's own browser. The leaderboard is per browser, so raiders who joined in another
browser do not appear in OBS's copy.

## Project layout

```
src/index.html          page markup, share metadata, overlay and wallet sheet
src/assets/styles.css   tokens and components (see DESIGN.md)
src/assets/raid.js      pure game rules: seasons, status parsing, damage, scoring
src/assets/wallet.js    EIP-6963 discovery, open-in-wallet links, personal_sign
src/assets/app.js       polling, persistence, rendering, wiring
src/favicon.svg, src/og.svg
dist/                   committed export, identical to src/
scripts/                build, check, preview
tests/raid.test.mjs     rule tests
```

## Wallets

Desktop extensions are discovered by EIP-6963 and listed by name and icon. If none announce
themselves but `window.ethereum` exists, one "Browser wallet" row appears. Phone browsers without
an injected wallet get "Open in MetaMask / Coinbase Wallet / Phantom" links. These are the vendors'
documented deep links and open this page in the wallet's own browser. There is no relay, no
WalletConnect project ID, no server and no private key. The sheet closes by its ×, by Escape or
by tapping the backdrop.

Not included: Coinbase Smart Wallet, which needs the Coinbase SDK, and an "Open in Rabby" row,
whose link form is not documented. The MetaMask and Phantom rows use a neutral wallet glyph,
because their official marks are not bundled.

## Verification record

This build's shell sandbox failed to start ("Failed to create bridge sockets"), and the browser
tool had no Chrome installed. **No command could be run in this session.** So:

| Check | Result |
| --- | --- |
| `npm run build` | **Not run.** `dist/` was written by hand as a byte copy of `src/`; `npm run build` reproduces it. |
| `npm run typecheck` | **Not run.** |
| `npm test` | **Not run.** Tests are written; their expected values were worked by hand. |
| `npm run check` | **Not run.** |
| design probe `taste.mjs` | **Not run** (needs Node and Playwright). |
| browser at 320 / 390 / 1440 | **Not performed.** No screenshot exists. |
| live API shape | **Not observed.** `api.squeekchain.com` and `squeekchain.com` answered 403 to this machine's fetch tool. The parser looks for the brief's names (`rpmMilli`, `cumulativeWorkUnits`, an IDLE/ACTIVE state) at any depth up to 3. |

Details, the six-domain design review and remaining limitations are in `artifacts/validation.md`.
Run the commands above before publishing anything that depends on them.
