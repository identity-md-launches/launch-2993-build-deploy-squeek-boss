// @ts-check
import {
  ROLES, ROUNDS, CHEER_COOLDOWN_MS, seasonClock, bossFor, parseStatus, freshness, seasonHp, newSeason,
  observe, cheer, activeStacks, multiplier, leaderboard, joinMessage, shortAddr, mmss,
} from "./raid.js";
import {
  startDiscovery, onWallets, listWallets, isMobileBrowser, OPEN_IN, GLYPH_URI, requestAccount, silentAccount,
  signMessage, walletErrorText,
} from "./wallet.js";

const API = "https://api.squeekchain.com/v1/status";
const POLL_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 10_000;
const KEY = "squeek-boss-raid:v1";
const params = new URLSearchParams(location.search);
const OVERLAY = params.get("mode") === "overlay";
const HP_OVERRIDE = Number(params.get("hp")) || null;

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @typedef {import("./raid.js").Season} Season
 * @typedef {import("./raid.js").Status} Status
 * @typedef {import("./raid.js").Role} Role
 * @typedef {import("./wallet.js").Wallet} Wallet
 * @typedef {{ tracker: import("./raid.js").Tracker, seasons: Record<string, Season>,
 *   session: { rdns: string, address: string } | null, role: Role, feed: { t: number, text: string }[] }} Saved
 */

/** @returns {Saved} */
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.tracker && s.seasons) return { feed: [], role: "tank", session: null, ...s };
  } catch {}
  return { tracker: { lastWork: null, lastWorkAt: null }, seasons: {}, session: null, role: "tank", feed: [] };
}

let saved = load();
function save() {
  const ids = Object.keys(saved.seasons).map(Number).sort((a, b) => b - a);
  for (const id of ids.slice(24)) delete saved.seasons[id];
  saved.feed = saved.feed.slice(0, 12);
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {}
}
// Another tab of this site wrote first: adopt its state so the same work is not credited twice.
addEventListener("storage", (e) => {
  if (e.key === KEY) {
    saved = load();
    render();
  }
});

/** @param {number} now @returns {Season} */
function season(now) {
  const { id } = seasonClock(now);
  let s = saved.seasons[id];
  if (!s) {
    const prev = saved.seasons[id - 1];
    s = newSeason(id, seasonHp(prev ? prev.damage : null, HP_OVERRIDE));
    saved.seasons[id] = s;
    feed(`${bossFor(id).name} appears with ${fmt(s.hp)} health.`, now);
    save();
  }
  return s;
}

/** @param {number} n */
function fmt(n) {
  if (!Number.isFinite(n)) return "0";
  return n >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString("en-US") : n.toFixed(1);
}

/** @param {string} text @param {number} now */
function feed(text, now) {
  saved.feed.unshift({ t: now, text });
  saved.feed = saved.feed.slice(0, 12);
}

/** @param {string} text */
function announce(text) {
  $("announcer").textContent = text;
}

/* ---------- live status ---------- */

/** @type {Status | null} */
let status = null;
/** @type {number | null} */
let lastOkAt = null;
/** @type {number | null} */
let lastChangeAt = null;
let lastBody = "";
/** @type {string | null} */
let etag = null;
let manualEtag = true;
let failures = 0;
/** @type {string | null} */
let lastError = null;

/** The live status, or null when it is unavailable or too old to trust. */
function liveStatus(now = Date.now()) {
  if (!status || lastOkAt === null || now - lastOkAt > STALE_AFTER_MS) return null;
  return status;
}

/** @param {AbortSignal} signal */
async function fetchStatus(signal) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (manualEtag && etag) headers["If-None-Match"] = etag;
  try {
    return await fetch(API, { headers, cache: "no-cache", signal });
  } catch (err) {
    // If-None-Match needs a CORS preflight. If the API refuses it, let the browser cache
    // revalidate with its own ETag instead (cache: "no-cache" sends If-None-Match itself).
    if (signal.aborted || !manualEtag) throw err;
    manualEtag = false;
    return await fetch(API, { cache: "no-cache", signal });
  }
}

async function poll() {
  const controller = new AbortController();
  // One deadline covers the request, any CORS fallback, and reading the response body.
  const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchStatus(controller.signal);
    if (res.status === 304 && status) {
      lastOkAt = Date.now();
    } else if (res.ok) {
      const tag = res.headers.get("ETag");
      const text = await res.text();
      const json = JSON.parse(text);
      const now = Date.now();
      if (text !== lastBody) {
        lastBody = text;
        lastChangeAt = now;
      }
      status = parseStatus(json, now);
      if (tag) etag = tag; // cache only a body that was fully read and parsed
      lastOkAt = now;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
    failures = 0;
    lastError = null;
    credit(Date.now());
  } catch (err) {
    failures += 1;
    lastError = controller.signal.aborted ? "request timed out after 10 seconds" : err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(deadline);
  }
  render();
  const hidden = document.hidden && !OVERLAY;
  const wait = failures ? Math.min(15_000, POLL_MS * 2 ** Math.min(failures, 3)) : hidden ? 10_000 : POLL_MS;
  setTimeout(poll, wait);
}

/** @param {number} now */
function credit(now) {
  if (!status) return;
  const s = season(now);
  const before = s.defeatedAt;
  const dealt = observe(saved.tracker, s, status, now);
  if (dealt > 0) {
    feed(`Wheel work dealt ${fmt(dealt)} damage in round ${seasonClock(now).round + 1}.`, now);
    hit(dealt);
  }
  if (before === null && s.defeatedAt !== null) {
    const top = leaderboard(s)[0];
    const msg = `${bossFor(s.id).name} is down${top ? `. Top raider: ${shortAddr(top.address)}` : ""}.`;
    feed(msg, now);
    announce(msg);
  }
  save();
}

/** @param {number} dealt */
function hit(dealt) {
  for (const id of ["boss-art", "o-art"]) {
    const el = $(id);
    el.classList.remove("hit");
    void el.offsetWidth;
    el.classList.add("hit");
  }
  const pop = $("pop");
  pop.textContent = `-${fmt(dealt)}`;
  pop.classList.remove("show");
  void pop.offsetWidth;
  pop.classList.add("show");
}

/* ---------- boss art ---------- */

/** @param {number} hue */
function bossSvg(hue) {
  const body = `hsl(${hue} 70% 56%)`;
  const light = `hsl(${hue} 75% 72%)`;
  return `<svg viewBox="0 0 120 120" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
<ellipse cx="60" cy="112" rx="38" ry="5" fill="#000" opacity=".4"/>
<path d="M30 40 L20 10 L46 30Z" fill="${light}"/><path d="M90 40 L100 10 L74 30Z" fill="${light}"/>
<rect x="20" y="26" width="80" height="82" rx="24" fill="${body}"/>
<rect x="36" y="66" width="48" height="32" rx="12" fill="${light}"/>
<circle cx="88" cy="84" r="4" fill="${light}"/><circle cx="30" cy="92" r="3" fill="${light}"/>
<circle cx="44" cy="52" r="10" fill="#0b0d17"/><circle cx="76" cy="52" r="10" fill="#0b0d17"/>
<circle class="eye" cx="46" cy="50" r="3.5" fill="#b8ff3c"/><circle class="eye" cx="78" cy="50" r="3.5" fill="#b8ff3c"/>
<path d="M32 36 L54 44 M88 36 L66 44" stroke="#0b0d17" stroke-width="5" stroke-linecap="round"/>
<path d="M44 74 h32" stroke="#0b0d17" stroke-width="5" stroke-linecap="round"/>
<path d="M48 76 l4 7 l4 -7 M64 76 l4 7 l4 -7" fill="#eef1ff"/>
</svg>`;
}

let artSeason = -1;

/* ---------- wallet ---------- */

/** @type {{ wallet: Wallet, address: string } | null} */
let account = null;
/** @type {string | null} */
let pendingId = null;
let joining = false;

const dialog = /** @type {HTMLDialogElement} */ ($("wallet-dialog"));

function renderSheet() {
  const list = $("wallet-list");
  list.replaceChildren();
  const mobile = isMobileBrowser();
  if (mobile) {
    for (const w of OPEN_IN) {
      const a = document.createElement("a");
      a.className = "row";
      a.href = w.href(location.href);
      a.append(icon(w.icon), text(`Open in ${w.name}`));
      list.append(a);
    }
  }
  const wallets = mobile ? [] : listWallets();
  for (const w of wallets) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row";
    b.disabled = pendingId !== null;
    b.append(icon(w.icon || GLYPH_URI), text(pendingId === w.id ? `${w.name}, opening` : w.name));
    b.addEventListener("click", () => connect(w));
    list.append(b);
  }
  if (!mobile && !wallets.length) {
    $("wallet-note").textContent = "No browser wallet found. Install a wallet extension, or open this page in your wallet app on a phone.";
  }
  // Re-rendering removes the row that had focus; keep focus inside the open sheet.
  if (dialog.open && !dialog.contains(document.activeElement)) $("wallet-close").focus();
}

/** @param {string} src */
function icon(src) {
  const span = document.createElement("span");
  span.className = "ic";
  const img = document.createElement("img");
  img.src = src;
  img.width = 28;
  img.height = 28;
  img.alt = "";
  span.append(img);
  return span;
}

/** @param {string} t */
function text(t) {
  const s = document.createElement("span");
  s.textContent = t;
  return s;
}

function openSheet() {
  $("wallet-note").textContent = "";
  renderSheet();
  dialog.showModal();
}

/** @param {Wallet} w */
async function connect(w) {
  pendingId = w.id;
  $("wallet-note").textContent = "";
  renderSheet();
  try {
    const address = await requestAccount(w.provider);
    setAccount(w, address);
    dialog.close();
  } catch (err) {
    $("wallet-note").textContent = walletErrorText(err);
  } finally {
    pendingId = null;
    if (dialog.open) renderSheet();
  }
}

/** @type {WeakSet<object>} */
const watched = new WeakSet();

/** @param {Wallet} w @param {string} address */
function setAccount(w, address) {
  account = { wallet: w, address: address.toLowerCase() };
  saved.session = { rdns: w.rdns, address: account.address };
  save();
  if (w.provider.on && !watched.has(w.provider)) {
    watched.add(w.provider);
    w.provider.on("accountsChanged", (/** @type {string[]} */ accs) => {
      if (!account || account.wallet !== w) return;
      if (accs && accs[0]) setAccount(w, accs[0]);
      else disconnect();
    });
  }
  render();
}

function disconnect() {
  const w = account && account.wallet;
  account = null;
  saved.session = null;
  save();
  if (w) w.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
  render();
}

let restoring = false;
async function restore() {
  const s = saved.session;
  if (!s || account || restoring) return;
  const w = listWallets().find((x) => x.rdns === s.rdns);
  if (!w) return;
  restoring = true;
  const a = await silentAccount(w.provider);
  restoring = false;
  if (a && a.toLowerCase() === s.address && !account) setAccount(w, a);
}

/** @returns {Role} */
function chosenRole() {
  const el = /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="role"]:checked'));
  const v = el ? el.value : "tank";
  return v === "runner" || v === "cheerleader" ? v : "tank";
}

async function join() {
  if (!account) return openSheet();
  const now = Date.now();
  const s = season(now);
  if (s.players[account.address]) return render();
  const role = chosenRole();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const message = joinMessage(account.address, role, s.id, nonce, new Date(now).toISOString());
  joining = true;
  $("join-error").textContent = "";
  render();
  try {
    const signature = await signMessage(account.wallet.provider, account.address, message);
    const at = Date.now();
    const cur = season(at);
    cur.players[account.address] = { address: account.address, role, score: 0, cheers: 0, boosts: [], lastCheerAt: 0, joinedAt: at, signature, message };
    feed(`${shortAddr(account.address)} joined as ${ROLES[role].name}.`, at);
    announce(`You joined as ${ROLES[role].name}.`);
    save();
  } catch (err) {
    $("join-error").textContent = walletErrorText(err);
  } finally {
    joining = false;
    render();
  }
}

function doCheer() {
  if (!account) return;
  const now = Date.now();
  const p = season(now).players[account.address];
  if (!p) return;
  if (cheer(p, now)) {
    save();
    announce(`Cheer sent. ${activeStacks(p, now)} boost stacks active.`);
  }
  render();
}

/* ---------- render ---------- */

function render() {
  const now = Date.now();
  const clock = seasonClock(now);
  const s = season(now);
  const boss = bossFor(s.id);
  const live = liveStatus(now);
  const left = Math.max(0, s.hp - s.damage);
  const pct = s.hp > 0 ? (left / s.hp) * 100 : 0;

  if (artSeason !== s.id) {
    artSeason = s.id;
    $("boss-art").innerHTML = bossSvg(boss.hue);
    $("o-art").innerHTML = bossSvg(boss.hue);
    $("boss-name").textContent = boss.name;
    $("o-name").textContent = boss.name;
    $("hp-rule").textContent = String(s.hp);
  }
  const down = s.defeatedAt !== null;
  $("boss").classList.toggle("down", down);
  $("o-art").classList.toggle("down", down);

  const seasonText = `Season ${s.id}, ends in ${mmss(clock.msLeft)}`;
  $("season-label").textContent = seasonText;
  $("o-sub").textContent = `Round ${clock.round + 1} of ${ROUNDS}, ${mmss(clock.roundMsLeft)} left`;

  const hpText = `${fmt(left)} of ${fmt(s.hp)} health`;
  for (const id of ["hp-fill", "o-fill"]) $(id).style.inlineSize = `${pct}%`;
  $("hp").setAttribute("aria-valuenow", String(Math.round(pct)));
  $("hp").setAttribute("aria-valuetext", hpText);
  $("hp-text").textContent = hpText;
  $("o-hp").textContent = hpText;

  const stateText = live ? (live.state === "ACTIVE" ? "Active" : live.state === "IDLE" ? "Idle" : "Unknown") : "Unknown";
  $("wheel-state").textContent = stateText;
  $("state-dot").dataset.state = live ? live.state : "UNKNOWN";
  $("o-state").textContent = `Wheel ${stateText.toLowerCase()}`;
  const rpmText = live && live.rpm !== null ? `${live.rpm.toFixed(1)} rpm` : "Unknown";
  $("rpm").textContent = rpmText;
  $("o-rpm").textContent = live && live.rpm !== null ? rpmText : "Speed unknown";
  $("round").textContent = `${clock.round + 1} of ${ROUNDS}, ${mmss(clock.roundMsLeft)}`;

  const f = freshness(live, lastChangeAt, now);
  const age = f.ageMs !== null ? `, ${mmss(f.ageMs)} old` : "";
  const freshText = live ? `${f.label[0].toUpperCase()}${f.label.slice(1)}${age}` : failures ? "Unavailable" : "Checking";
  $("fresh").textContent = freshText;
  $("fresh").dataset.state = live ? f.label : "unknown";
  $("o-fresh").textContent = live ? `Data ${f.label}${age}` : "Data unavailable";

  const banner = $("banner");
  if (down) {
    banner.hidden = false;
    banner.textContent = `${boss.name} is down. A new boss arrives in ${mmss(clock.msLeft)}.`;
  } else if (!live && (failures || lastError)) {
    banner.hidden = false;
    banner.textContent = `Squeekchain status is unavailable (${lastError || "no answer"}). Damage pauses until it answers; nothing is guessed.`;
  } else {
    banner.hidden = true;
  }

  renderJoin(s, live, now);
  renderBoard(s);
  renderRounds(s, clock.round);
  renderFeed();
}

/** @param {Season} s @param {Status | null} live @param {number} now */
function renderJoin(s, live, now) {
  $("connect").textContent = account ? `${shortAddr(account.address)} · Disconnect` : "Connect wallet";
  const p = account ? s.players[account.address] : null;
  $("join-form").hidden = !!p;
  $("me").hidden = !p;
  const btn = /** @type {HTMLButtonElement} */ ($("join-btn"));
  btn.disabled = joining || s.defeatedAt !== null;
  btn.textContent = s.defeatedAt !== null ? "Boss is down, next season soon" : !account ? "Connect wallet to join" : joining ? "Check your wallet" : "Sign to join";
  for (const el of document.querySelectorAll('input[name="role"]')) {
    const input = /** @type {HTMLInputElement} */ (el);
    input.checked = input.value === saved.role;
  }
  if (!p) return;
  $("me-role").textContent = ROLES[p.role].name;
  $("me-addr").textContent = shortAddr(p.address);
  $("me-score").textContent = `${fmt(p.score)} points`;
  const stacks = activeStacks(p, now);
  const mult = multiplier(p, live, now);
  $("me-boost").textContent = stacks
    ? `${stacks} cheer ${stacks === 1 ? "stack" : "stacks"}, earning ${mult.toFixed(2)}× per damage`
    : `No cheer boost, earning ${mult.toFixed(2)}× per damage`;
  const cool = CHEER_COOLDOWN_MS - (now - p.lastCheerAt);
  const cb = /** @type {HTMLButtonElement} */ ($("cheer-btn"));
  cb.disabled = cool > 0 || s.defeatedAt !== null;
  cb.textContent = s.defeatedAt !== null ? "Boss is down" : cool > 0 ? `Cheer again in ${Math.ceil(cool / 1000)}s` : `Cheer (${p.cheers} sent)`;
}

/** @param {Season} s */
function renderBoard(s) {
  const rows = leaderboard(s);
  $("board-empty").hidden = rows.length > 0;
  const mk = (/** @type {import("./raid.js").Player} */ p, /** @type {number} */ i) => {
    const li = document.createElement("li");
    if (account && p.address === account.address) li.className = "me-row";
    const rank = document.createElement("span");
    rank.className = "rank num";
    rank.textContent = String(i + 1);
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = `${shortAddr(p.address)} · ${ROLES[p.role].name}`;
    const pts = document.createElement("span");
    pts.className = "pts num";
    pts.textContent = fmt(p.score);
    li.append(rank, who, pts);
    return li;
  };
  $("board").replaceChildren(...rows.slice(0, 20).map(mk));
  $("o-board").replaceChildren(...rows.slice(0, 3).map(mk));
}

/** @param {Season} s @param {number} current */
function renderRounds(s, current) {
  const max = Math.max(1, ...s.roundDamage);
  const items = s.roundDamage.map((d, i) => {
    const li = document.createElement("li");
    if (i === current) li.className = "now";
    const label = document.createElement("span");
    label.className = "r-label";
    label.textContent = `Round ${i + 1}${i === current ? ", now" : ""}`;
    const bar = document.createElement("span");
    bar.className = "r-bar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.style.inlineSize = `${(d / max) * 100}%`;
    bar.append(fill);
    const val = document.createElement("span");
    val.className = "r-val num";
    val.textContent = fmt(d);
    li.append(label, bar, val);
    return li;
  });
  $("rounds").replaceChildren(...items);
}

let feedKey = "";
function renderFeed() {
  const key = saved.feed.map((f) => f.t).join();
  if (key === feedKey) return;
  feedKey = key;
  $("feed-empty").hidden = saved.feed.length > 0;
  $("feed").replaceChildren(
    ...saved.feed.map((f) => {
      const li = document.createElement("li");
      const t = document.createElement("time");
      t.className = "num muted";
      t.dateTime = new Date(f.t).toISOString();
      t.textContent = new Date(f.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      li.append(t, text(f.text));
      return li;
    }),
  );
}

/* ---------- wiring ---------- */

function init() {
  if (OVERLAY) document.documentElement.classList.add("is-overlay");
  $("connect").addEventListener("click", () => (account ? disconnect() : openSheet()));
  $("join-btn").addEventListener("click", join);
  $("cheer-btn").addEventListener("click", doCheer);
  $("wallet-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  for (const el of document.querySelectorAll('input[name="role"]')) {
    el.addEventListener("change", () => {
      saved.role = chosenRole();
      save();
    });
  }
  const url = new URL(location.href);
  url.search = "?mode=overlay";
  url.hash = "";
  const input = /** @type {HTMLInputElement} */ ($("overlay-url"));
  input.value = url.toString();
  $("copy-overlay").addEventListener("click", async () => {
    const b = $("copy-overlay");
    try {
      await navigator.clipboard.writeText(input.value);
      b.textContent = "Copied";
    } catch {
      input.select();
      b.textContent = "Press Ctrl+C";
    }
    setTimeout(() => (b.textContent = "Copy link"), 2000);
  });

  startDiscovery();
  onWallets(() => {
    if (dialog.open) renderSheet();
    if (!account) restore();
  });
  setTimeout(restore, 300);

  render();
  poll();
  setInterval(render, 1000);
}

init();
