// Interaction-level rules of the raid, run with `npm test` (node:test, no dependencies).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SEASON_MS, ROUND_MS, seasonClock, parseStatus, freshness, seasonHp, newSeason, observe, cheer,
  activeStacks, multiplier, leaderboard, joinMessage, DEFAULT_HP,
} from "../src/assets/raid.js";

const T0 = 1_800_000 * SEASON_MS; // the start of some season
// Public GET /v1/status captured 2026-11-05; retains builder/oracle/module fields
// so unrelated pipeline status and document timestamps cannot mask wheel telemetry.
const liveDocument = JSON.parse(readFileSync(new URL("./fixtures/status-2026-11-05.json", import.meta.url), "utf8"));
const status = (work, extra = {}) => ({ state: "ACTIVE", rpm: 40, work, updatedAt: null, fresh: null, ...extra });
const player = (address, role, joinedAt = T0) => ({ address, role, score: 0, cheers: 0, boosts: [], lastCheerAt: 0, joinedAt, signature: "0x", message: "" });

test("season clock: six 600 s rounds per hour", () => {
  const c = seasonClock(T0 + 3 * ROUND_MS + 5_000);
  assert.equal(c.round, 3);
  assert.equal(c.roundMsLeft, ROUND_MS - 5_000);
  assert.equal(seasonClock(T0 + SEASON_MS - 1).round, 5);
});

test("parseStatus reads rpmMilli, cumulativeWorkUnits and state, nested or flat", () => {
  const flat = parseStatus({ state: "ACTIVE", rpmMilli: 42500, cumulativeWorkUnits: "1200" }, T0);
  assert.equal(flat.state, "ACTIVE");
  assert.equal(flat.rpm, 42.5);
  assert.equal(flat.work, 1200);
  const nested = parseStatus({ wheel: { status: "idle", rpmMilli: 0 }, totals: { cumulativeWorkUnits: 7 } }, T0);
  assert.equal(nested.state, "IDLE");
  assert.equal(nested.rpm, 0);
  assert.equal(nested.work, 7);
  assert.equal(parseStatus({ status: "INACTIVE" }, T0).state, "IDLE");
});

test("missing fields stay unknown, never zero", () => {
  const s = parseStatus({ ok: true }, T0);
  assert.equal(s.state, "UNKNOWN");
  assert.equal(s.rpm, null);
  assert.equal(s.work, null);
  assert.equal(freshness(null, null, T0).label, "unknown");
});

test("current API measurement controls Idle/Active and the Runner bonus", () => {
  const now = Date.parse(liveDocument.generatedAt);
  const idle = parseStatus(liveDocument, now);
  assert.equal(idle.state, "IDLE");
  assert.equal(idle.rpm, 0);
  assert.equal(idle.work, 3817);
  assert.equal(idle.updatedAt, Date.parse(liveDocument.measurement.observedAt));
  const json = structuredClone(liveDocument);
  json.measurement.coreStatus = "ACTIVE";
  json.measurement.rpmMilli = 42500;
  json.state = "IDLE"; // canonical measurement wins even over a conflicting legacy field
  const active = parseStatus(json, now);
  assert.equal(active.state, "ACTIVE");
  assert.equal(active.rpm, 42.5);
  assert.equal(multiplier(player("runner", "runner"), active, now), 1.5);
  assert.equal(multiplier(player("runner", "runner"), idle, now), 1);
});

test("legacy state fallbacks validate complete values and ignore pipeline statuses", () => {
  assert.equal(parseStatus({status:"available", wheel:{state:"active"}}, T0).state, "ACTIVE");
  assert.equal(parseStatus({state:"not_active"}, T0).state, "UNKNOWN");
  assert.equal(parseStatus({status:"IDLE_PENDING"}, T0).state, "UNKNOWN");
  assert.equal(parseStatus({builder:{status:"ACTIVE"}, oracle:{active:true}}, T0).state, "UNKNOWN");
  assert.equal(parseStatus({wheel:{isActive:false}}, T0).state, "IDLE");
  const fault = structuredClone(liveDocument);
  fault.measurement.coreStatus = "COUNTER_FAULT";
  fault.state = "ACTIVE";
  assert.equal(parseStatus(fault, T0).state, "UNKNOWN", "explicit device faults cannot become active");
});

test("measurement timestamps and explicit stale flag override document generation", () => {
  const now = Date.parse(liveDocument.generatedAt);
  const json = structuredClone(liveDocument);
  json.generatedAt = new Date(now).toISOString();
  json.measurement.observedAt = new Date(now - 900_000).toISOString();
  json.measurement.receivedAt = new Date(now - 899_000).toISOString();
  json.measurement.freshness = "stale";
  const parsed = parseStatus(json, now);
  assert.equal(parsed.updatedAt, now - 900_000);
  assert.equal(parsed.fresh, false);
  assert.deepEqual(freshness(parsed, now, now), {label:"stale",ageMs:900_000});
  // Even a just-observed reading cannot override the API's explicit stale signal.
  json.measurement.observedAt = new Date(now - 1_000).toISOString();
  json.measurement.fresh = true;
  assert.deepEqual(freshness(parseStatus(json, now), now, now), {label:"stale",ageMs:1_000});
});

test("missing or invalid observedAt falls back to receivedAt, never generatedAt", () => {
  const now = Date.parse(liveDocument.generatedAt);
  const json = structuredClone(liveDocument);
  json.measurement.observedAt = "invalid";
  json.measurement.receivedAt = new Date(now - 900_000).toISOString();
  json.measurement.freshness = "online";
  assert.deepEqual(freshness(parseStatus(json, now), now, now), {label:"stale",ageMs:900_000});
  delete json.measurement.observedAt;
  assert.equal(parseStatus(json, now).updatedAt, now - 900_000);
  delete json.measurement.receivedAt;
  assert.equal(parseStatus(json, now).updatedAt, null);
  assert.equal(freshness(parseStatus(json, now), null, now).label, "unknown");
});

test("304 or regenerated documents do not reset the wheel measurement's age", () => {
  const now = Date.parse(liveDocument.generatedAt);
  const json = structuredClone(liveDocument);
  json.measurement.observedAt = new Date(now - 20_000).toISOString();
  const parsed = parseStatus(json, now);
  assert.deepEqual(freshness(parsed, now, now), {label:"fresh",ageMs:20_000});
  assert.deepEqual(freshness(parsed, now+20_000, now+20_000), {label:"aging",ageMs:40_000});
  json.generatedAt = new Date(now+20_000).toISOString();
  assert.deepEqual(freshness(parseStatus(json, now+20_000), now+20_000, now+20_000), {label:"aging",ageMs:40_000});
});

test("damage is the sum of measured increases inside one season", () => {
  const tracker = { lastWork: null, lastWorkAt: null };
  const season = newSeason(seasonClock(T0).id, 1000);
  assert.equal(observe(tracker, season, status(100), T0 + 1_000), 0, "first reading is a baseline");
  assert.equal(observe(tracker, season, status(130), T0 + 3_000), 30);
  assert.equal(observe(tracker, season, status(null), T0 + 5_000), 0, "unavailable credits nothing");
  assert.equal(observe(tracker, season, status(120), T0 + 7_000), 0, "a drop credits nothing");
  assert.equal(observe(tracker, season, status(125), T0 + 9_000), 5, "rebaselined after the drop");
  assert.equal(season.damage, 35);
  assert.equal(season.roundDamage[0], 35);
});

test("readings from the previous season are not credited to this one", () => {
  const tracker = { lastWork: 100, lastWorkAt: T0 - 1_000 };
  const season = newSeason(seasonClock(T0).id, 1000);
  assert.equal(observe(tracker, season, status(150), T0 + 1_000), 0);
  assert.equal(observe(tracker, season, status(160), T0 + 3_000), 10);
});

test("boss is defeated at zero health and damage stops", () => {
  const tracker = { lastWork: 0, lastWorkAt: T0 };
  const season = newSeason(seasonClock(T0).id, 50);
  assert.equal(observe(tracker, season, status(80), T0 + 2_000), 50);
  assert.notEqual(season.defeatedAt, null);
  assert.equal(observe(tracker, season, status(90), T0 + 4_000), 0);
});

test("roles, cheers and the leaderboard", () => {
  const tracker = { lastWork: 0, lastWorkAt: T0 };
  const season = newSeason(seasonClock(T0).id, 10_000);
  season.players.a = player("0xaaaa000000000000000000000000000000000001", "tank");
  season.players.b = player("0xbbbb000000000000000000000000000000000002", "runner");
  season.players.c = player("0xcccc000000000000000000000000000000000003", "cheerleader");
  assert.equal(cheer(season.players.c, T0 + 100), true);
  assert.equal(cheer(season.players.c, T0 + 200), false, "cooldown");
  assert.equal(activeStacks(season.players.c, T0 + 1_000), 1);
  observe(tracker, season, status(100), T0 + 2_000);
  assert.equal(season.players.a.score, 100);
  assert.equal(season.players.b.score, 150);
  assert.ok(Math.abs(season.players.c.score - 88) < 1e-9);
  assert.deepEqual(leaderboard(season).map((p) => p.role), ["runner", "tank", "cheerleader"]);
  assert.equal(multiplier(season.players.b, status(0, { rpm: 10 }), T0), 1, "runner bonus needs 30+ rpm");
});

test("boss health scales from the previous season", () => {
  assert.equal(seasonHp(null, null), DEFAULT_HP);
  assert.equal(seasonHp(1000, null), 1150);
  assert.equal(seasonHp(1000, 42), 42);
});

test("join message names the season, role and wallet", () => {
  const m = joinMessage("0xabc", "runner", 7, "n1", "2026-01-01T00:00:00.000Z");
  assert.match(m, /Join season 7 as Runner\./);
  assert.match(m, /no gas/);
});
