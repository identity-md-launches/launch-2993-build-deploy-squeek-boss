// @ts-check
/**
 * Squeek Boss Raid: pure game rules. No DOM, no network, so they can be tested in Node.
 *
 * Season: one UTC hour. Round: 600 s, six per season.
 * Boss damage = sum of positive increases in measured `cumulativeWorkUnits` between consecutive
 * successful status observations that both fall inside the same season.
 *   damage(season) = sum over i of max(0, W[i] - W[i-1]), with W[i-1] observed in the same season.
 * A decrease (counter reset) or an unavailable status credits nothing; nothing is ever inferred.
 */

export const SEASON_MS = 3_600_000;
export const ROUND_MS = 600_000;
export const ROUNDS = 6;
export const DEFAULT_HP = 500;
export const MIN_HP = 100;
export const HP_GROWTH = 1.15;
export const RUNNER_RPM = 30;
export const CHEER_COOLDOWN_MS = 3_000;
export const CHEER_BOOST = 0.1;

/** @typedef {"tank" | "runner" | "cheerleader"} Role */
/** @typedef {"ACTIVE" | "IDLE" | "UNKNOWN"} WheelState */

/**
 * @typedef {Object} Status
 * @property {WheelState} state
 * @property {number | null} rpm
 * @property {number | null} work
 * @property {number | null} updatedAt  ms timestamp the API reports for its round data, if any
 * @property {boolean | null} fresh      freshness flag the API reports, if any
 */

/** @type {Record<Role, { name: string, mult: string, cap: number, cheerMs: number }>} */
export const ROLES = {
  tank: { name: "Tank", mult: "1.0×", cap: 5, cheerMs: 60_000 },
  runner: { name: "Runner", mult: "1.5× at 30+ rpm", cap: 5, cheerMs: 30_000 },
  cheerleader: { name: "Cheerleader", mult: "0.8×", cap: 10, cheerMs: 30_000 },
};

export const BOSSES = [
  "Gouda Golem",
  "Rustgear Rex",
  "The Static Owl",
  "Byte Weasel",
  "Mold Monarch",
  "Cable Kraken",
  "Lag Lich",
  "Crumb Colossus",
];

/** @param {number} now */
export function seasonClock(now) {
  const id = Math.floor(now / SEASON_MS);
  const startsAt = id * SEASON_MS;
  const into = now - startsAt;
  const round = Math.min(ROUNDS - 1, Math.floor(into / ROUND_MS));
  const roundEndsAt = startsAt + (round + 1) * ROUND_MS;
  return {
    id,
    startsAt,
    endsAt: startsAt + SEASON_MS,
    round,
    roundEndsAt,
    msLeft: startsAt + SEASON_MS - now,
    roundMsLeft: roundEndsAt - now,
  };
}

/** @param {number} seasonId */
export function bossFor(seasonId) {
  const i = ((seasonId % BOSSES.length) + BOSSES.length) % BOSSES.length;
  return { name: BOSSES[i], hue: (seasonId * 47) % 360 };
}

/**
 * Breadth-first search for the first non-null primitive value under any of `names`, a few
 * levels deep, so `{ wheel: { rpmMilli } }` and `{ rpmMilli }` both resolve.
 * @param {unknown} obj @param {string[]} names
 * @returns {unknown}
 */
export function findKey(obj, names, maxDepth = 3) {
  /** @type {Array<[unknown, number]>} */
  const queue = [[obj, 0]];
  while (queue.length) {
    const [node, depth] = /** @type {[unknown, number]} */ (queue.shift());
    if (!node || typeof node !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (node);
    for (const n of names) {
      const v = rec[n];
      if (v !== undefined && v !== null && typeof v !== "object") return v;
    }
    if (depth < maxDepth) for (const v of Object.values(rec)) if (v && typeof v === "object") queue.push([v, depth + 1]);
  }
  return undefined;
}

/** @param {unknown} v @returns {number | null} */
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/** @param {unknown} v @returns {number | null} ms since epoch */
export function toMs(v) {
  const n = toNumber(v);
  if (n !== null) {
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return null;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** @param {unknown} v @returns {Record<string, unknown>} */
function record(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
}

/** Accept only wheel states, never substrings such as "unavailable" or "not_active".
 * @param {unknown} v @returns {WheelState} */
function wheelState(v) {
  if (typeof v !== "string") return "UNKNOWN";
  const s = v.trim().toUpperCase();
  return s === "ACTIVE" ? "ACTIVE" : s === "IDLE" || s === "INACTIVE" ? "IDLE" : "UNKNOWN";
}

/**
 * Normalise the status document. Anything missing stays null or UNKNOWN, never zero.
 * @param {unknown} json @param {number} now
 * @returns {Status}
 */
export function parseStatus(json, now) {
  const root = record(json);
  const measurement = record(root.measurement);
  /** @type {WheelState} */
  let state = wheelState(measurement.coreStatus);
  // An explicit device fault stays unknown. Legacy states are accepted only from the
  // measurement, wheel or root object; builder/oracle/module statuses are not wheel states.
  if (measurement.coreStatus === undefined || measurement.coreStatus === null) {
    for (const source of [measurement, record(root.wheel), root]) {
      for (const key of ["coreStatus", "state", "wheelState", "status", "mode"]) {
        state = wheelState(source[key]);
        if (state !== "UNKNOWN") break;
      }
      if (state === "UNKNOWN") {
        const b = source.active ?? source.isActive;
        if (typeof b === "boolean") state = b ? "ACTIVE" : "IDLE";
      }
      if (state !== "UNKNOWN") break;
    }
  }

  const milli = toNumber(findKey(json, ["rpmMilli"]));
  const rpm = milli !== null ? milli / 1000 : null;

  const work = toNumber(findKey(json, ["cumulativeWorkUnits"]));

  // Document generation is not a wheel observation. Prefer device time, then receipt
  // time; timestamp/age fallbacks apply only to older documents without measurement.
  const legacy = !("measurement" in root);
  let updatedAt = toMs(measurement.observedAt) ?? toMs(measurement.receivedAt);
  if (updatedAt === null && legacy) updatedAt = toMs(
    findKey(json, ["roundUpdatedAt", "lastRoundAt", "roundAt", "updatedAt", "lastUpdatedAt", "observedAt", "receivedAt", "asOf", "timestamp"]),
  );
  if (updatedAt === null && legacy) {
    const ageMs = toNumber(findKey(json, ["roundAgeMs", "ageMs"]));
    const ageSec = toNumber(findKey(json, ["roundAgeSec", "roundAgeSeconds", "ageSec", "ageSeconds"]));
    if (ageMs !== null) updatedAt = now - ageMs;
    else if (ageSec !== null) updatedAt = now - ageSec * 1000;
  }
  if (updatedAt !== null && updatedAt > now + 60_000) updatedAt = now;

  /** @type {boolean | null} */
  let fresh = typeof measurement.freshness === "string" && measurement.freshness.toLowerCase() === "stale" ? false : null;
  if (fresh === null) {
    const f = findKey(legacy ? json : measurement, ["fresh", "isFresh"]);
    const st = findKey(legacy ? json : measurement, ["stale", "isStale"]);
    if (typeof f === "boolean") fresh = f;
    else if (typeof st === "boolean") fresh = !st;
  }

  return { state, rpm, work, updatedAt, fresh };
}

/**
 * Round freshness label from the API's own timestamp or flag, else from when this browser
 * last saw the data change.
 * @param {Status | null} status @param {number | null} lastChangeAt @param {number} now
 * @returns {{ label: "fresh" | "aging" | "stale" | "unknown", ageMs: number | null }}
 */
export function freshness(status, lastChangeAt, now) {
  if (!status) return { label: "unknown", ageMs: null };
  const at = status.updatedAt ?? lastChangeAt;
  const ageMs = at === null ? null : Math.max(0, now - at);
  if (status.fresh === false) return { label: "stale", ageMs };
  if (ageMs === null) return { label: status.fresh ? "fresh" : "unknown", ageMs };
  if (ageMs <= 30_000) return { label: "fresh", ageMs };
  if (ageMs <= ROUND_MS) return { label: "aging", ageMs };
  return { label: "stale", ageMs };
}

/** @param {number | null} prevDamage @param {number | null} override */
export function seasonHp(prevDamage, override) {
  if (override && override > 0) return Math.round(override);
  if (prevDamage && prevDamage > 0) return Math.max(MIN_HP, Math.round(prevDamage * HP_GROWTH));
  return DEFAULT_HP;
}

/**
 * @typedef {Object} Player
 * @property {string} address
 * @property {Role} role
 * @property {number} score
 * @property {number} cheers      total cheers sent
 * @property {number[]} boosts    expiry timestamps of active cheer stacks
 * @property {number} lastCheerAt
 * @property {number} joinedAt
 * @property {string} signature
 * @property {string} message
 */

/**
 * @typedef {Object} Season
 * @property {number} id
 * @property {number} hp
 * @property {number} damage
 * @property {number[]} roundDamage
 * @property {number | null} defeatedAt
 * @property {Record<string, Player>} players
 */

/** @param {number} id @param {number} hp @returns {Season} */
export function newSeason(id, hp) {
  return { id, hp, damage: 0, roundDamage: Array(ROUNDS).fill(0), defeatedAt: null, players: {} };
}

/** @param {Player} p @param {number} now */
export function activeStacks(p, now) {
  return p.boosts.filter((t) => t > now).length;
}

/** @param {Player} p @param {Status | null} status @param {number} now */
export function multiplier(p, status, now) {
  let role = 1;
  if (p.role === "runner") role = status && status.state === "ACTIVE" && (status.rpm ?? 0) >= RUNNER_RPM ? 1.5 : 1;
  if (p.role === "cheerleader") role = 0.8;
  return role * (1 + CHEER_BOOST * activeStacks(p, now));
}

/**
 * Add a cheer stack. Returns false while on cooldown.
 * @param {Player} p @param {number} now
 */
export function cheer(p, now) {
  if (now - p.lastCheerAt < CHEER_COOLDOWN_MS) return false;
  const cfg = ROLES[p.role];
  const live = p.boosts.filter((t) => t > now);
  if (live.length >= cfg.cap) live.sort((a, b) => a - b).shift();
  live.push(now + cfg.cheerMs);
  p.boosts = live;
  p.lastCheerAt = now;
  p.cheers += 1;
  return true;
}

/**
 * @typedef {Object} Tracker
 * @property {number | null} lastWork
 * @property {number | null} lastWorkAt
 */

/**
 * Credit one observation. Returns the damage dealt to `season` (0 when nothing is credited).
 * @param {Tracker} tracker @param {Season} season @param {Status} status @param {number} now
 */
export function observe(tracker, season, status, now) {
  const w = status.work;
  if (w === null) return 0;
  const prev = tracker.lastWork;
  const prevAt = tracker.lastWorkAt;
  tracker.lastWork = w;
  tracker.lastWorkAt = now;
  if (prev === null || prevAt === null) return 0;
  if (Math.floor(prevAt / SEASON_MS) !== season.id) return 0;
  const delta = w - prev;
  if (!(delta > 0)) return 0;
  if (season.defeatedAt !== null) return 0;

  const left = season.hp - season.damage;
  const dealt = Math.min(delta, left);
  season.damage += dealt;
  season.roundDamage[seasonClock(now).round] += dealt;
  for (const p of Object.values(season.players)) {
    if (p.joinedAt <= now) p.score += dealt * multiplier(p, status, now);
  }
  if (season.damage >= season.hp) season.defeatedAt = now;
  return dealt;
}

/** @param {Season} season */
export function leaderboard(season) {
  return Object.values(season.players).sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
}

/** @param {string} address @param {Role} role @param {number} seasonId @param {string} nonce @param {string} issued */
export function joinMessage(address, role, seasonId, nonce, issued) {
  return [
    "Squeek Boss Raid",
    `Join season ${seasonId} as ${ROLES[role].name}.`,
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${issued}`,
    "This signature costs no gas and grants no permissions.",
  ].join("\n");
}

/** @param {string} a */
export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** @param {number} ms */
export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
