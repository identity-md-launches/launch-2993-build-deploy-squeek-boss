// Optional browser regression checks against the production export. No application dependencies.
// Install Playwright separately and set IMD_PLAYWRIGHT to its index.mjs, as for taste@1.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.IMD_PLAYWRIGHT
  ? pathToFileURL(resolve(process.env.IMD_PLAYWRIGHT)).href : "playwright");
const API = "https://api.squeekchain.com/v1/status";
const out = resolve("test/scratch/revision");
await mkdir(out, { recursive: true });
const captured = JSON.parse(await readFile(new URL("../tests/fixtures/status-2026-11-05.json", import.meta.url), "utf8"));
const now = Date.parse(captured.generatedAt);
const dist = resolve("dist");
const streaming = { requests: 0, headers: [] };
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/preview/streaming-status") {
    streaming.requests++;
    streaming.headers.push(req.headers["if-none-match"]);
    if (streaming.requests === 2) {
      res.writeHead(200, { "Content-Type": "application/json", ETag: '"unfinished-body"' });
      res.write('{"measurement":'); // real headers arrive; the body never completes
      return;
    }
    if (req.headers["if-none-match"] === '"unfinished-body"') return res.writeHead(304).end();
    const work = streaming.requests === 1 ? "3817" : "3827";
    res.writeHead(200, { "Content-Type": "application/json", ETag: '"completed-body"' });
    return res.end(JSON.stringify(document({ cumulativeWorkUnits: work })));
  }
  const path = resolve(dist, decodeURIComponent(url.pathname.replace(/^\/preview\//, "")) || "index.html");
  if (!path.startsWith(dist + "/")) return res.writeHead(404).end();
  try {
    const body = await readFile(path);
    const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" }[extname(path)];
    res.writeHead(200, { "Content-Type": type || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}/preview/`;
const results = [];
let browser;

function document(overrides = {}) {
  return { ...structuredClone(captured), generatedAt: new Date(now).toISOString(),
    measurement: { ...captured.measurement, observedAt: new Date(now).toISOString(),
      receivedAt: new Date(now).toISOString(), ...overrides } };
}

async function freshPage(width = 390, height = 844) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { if (r.url().startsWith(base) && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.clock.install({ time: new Date(now) });
  return { page, errors };
}

async function check(name, fn) {
  await fn();
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "horizontal overflow");
}

try {
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 1440]) await check(`current API Idle at ${width}px`, async () => {
    const { page, errors } = await freshPage(width, width === 1440 ? 900 : 844);
    await page.route(API, (route) => route.fulfill({ json: captured }));
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector("#wheel-state").textContent === "Idle");
    assert.equal(await page.locator("#rpm").textContent(), "0.0 rpm");
    const action = await page.locator("#connect").boundingBox();
    assert.ok(action.y >= 0 && action.y + action.height <= 844, "connect is on the first screen");
    await noOverflow(page);
    await page.screenshot({ path: `${out}/idle-${width}.png` });
    assert.deepEqual(errors, []);
    await page.close();
  });

  for (const width of [320, 390, 1440]) for (const mode of ["", "?mode=overlay"]) await check(`stale telemetry ${mode || "game"} at ${width}px`, async () => {
    const { page, errors } = await freshPage(width, width === 1440 ? 900 : 844);
    const json = document({ freshness: "stale", observedAt: new Date(now - 900_000).toISOString(), receivedAt: new Date(now - 900_000).toISOString() });
    await page.clock.setFixedTime(new Date(now));
    await page.route(API, (route) => route.fulfill({ json }));
    await page.goto(base + mode);
    await page.waitForFunction(() => document.querySelector("#fresh").textContent === "Stale, 15:00 old");
    assert.equal(await page.locator("#o-fresh").textContent(), "Data stale, 15:00 old");
    if (mode) assert.equal(await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
    await noOverflow(page);
    await page.screenshot({ path: `${out}/stale-${mode ? "overlay" : "game"}-${width}.png` });
    assert.deepEqual(errors, []);
    await page.close();
  });

  await check("pending request times out, retries, and recovers", async () => {
    const { page, errors } = await freshPage();
    let requests = 0;
    let recover = false;
    await page.route(API, (route) => { requests++; if (recover) return route.fulfill({ json: document() }); });
    await page.goto(base);
    await page.clock.runFor(10_100);
    await page.locator("#banner:not([hidden])").waitFor();
    assert.match(await page.locator("#banner").textContent(), /timed out after 10 seconds/);
    assert.equal(await page.locator("#fresh").textContent(), "Unavailable");
    assert.equal(await page.locator("#wheel-state").textContent(), "Unknown");
    assert.equal(await page.locator("#rpm").textContent(), "Unknown");
    await page.screenshot({ path: `${out}/request-timeout.png` });
    await Promise.all([page.waitForRequest(API), page.clock.runFor(4_100)]);
    assert.equal(requests, 2, "next request is made after the timeout");
    recover = true;
    await page.clock.runFor(18_100);
    await page.waitForFunction(() => document.querySelector("#wheel-state").textContent === "Idle");
    assert.equal(requests, 3);
    assert.equal(await page.locator("#banner").getAttribute("hidden"), "");
    assert.equal(await page.locator("#hp-text").textContent(), "500 of 500 health");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await check("keyboard wallet sheet, declined signature, Runner join, cheer, damage and persistence", async () => {
    const { page, errors } = await freshPage();
    await page.addInitScript(() => {
      // Test-only EIP-6963 provider: no wallet, private key or transaction is used.
      const address = "0x1234567890123456789012345678901234567890";
      let declined = false;
      window.__walletCalls = [];
      const provider = { request: async (args) => {
        window.__walletCalls.push(args);
        if (args.method === "eth_requestAccounts" || args.method === "eth_accounts") return [address];
        if (args.method === "wallet_revokePermissions") return null;
        if (args.method === "personal_sign") {
          if (!declined) { declined = true; throw { code: 4001, message: "Test rejection" }; }
          return new Promise((done) => { window.__resolveSign = () => done("0x" + "11".repeat(65)); });
        }
        throw new Error(`Unexpected wallet request: ${args.method}`);
      } };
      addEventListener("eip6963:requestProvider", () => dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: { info: { uuid: "validation-wallet", rdns: "test.validation", name: "Validation wallet" }, provider },
      })));
    });
    let work = 3817;
    const headers = [];
    await page.route(API, (route) => {
      const etag = `"validation-${work}"`;
      const tag = route.request().headers()["if-none-match"];
      headers.push(tag);
      return tag === etag ? route.fulfill({ status: 304 }) : route.fulfill({ json: document({ coreStatus: "ACTIVE", rpmMilli: 42500, cumulativeWorkUnits: String(work) }), headers: { ETag: etag, "Access-Control-Expose-Headers": "ETag" } });
    });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector("#wheel-state").textContent === "Active");
    assert.equal(await page.locator("#rpm").textContent(), "42.5 rpm");
    await page.locator("#connect").focus();
    await page.keyboard.press("Enter");
    await page.locator("#wallet-dialog[open]").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement.id), "connect");
    await page.locator('input[value="runner"]').check();
    await page.locator("#connect").click();
    await page.getByRole("button", { name: "Validation wallet", exact: true }).click();
    await page.locator("#join-btn").click();
    await page.waitForFunction(() => document.querySelector("#join-error").textContent.includes("Request declined"));
    assert.equal(await page.locator("#me").isVisible(), false);
    await page.locator("#join-btn").click();
    await page.waitForFunction(() => document.querySelector("#join-btn").textContent === "Check your wallet");
    assert.equal(await page.locator("#join-btn").isDisabled(), true);
    await page.evaluate(() => window.__resolveSign());
    await page.locator("#me").waitFor({ state: "visible" });
    assert.equal(await page.locator("#me-role").textContent(), "Runner");
    assert.match(await page.locator("#me-boost").textContent(), /1.50×/);
    work += 10;
    await page.clock.runFor(2_100);
    await page.waitForFunction(() => document.querySelector("#me-score").textContent === "15 points");
    await page.locator("#cheer-btn").click();
    assert.equal(await page.locator("#cheer-btn").isDisabled(), true);
    assert.match(await page.locator("#me-boost").textContent(), /1.65×/);
    work += 10;
    await page.clock.runFor(2_100);
    await page.waitForFunction(() => document.querySelector("#me-score").textContent === "31.5 points");
    assert.equal(await page.locator("#hp-text").textContent(), "480 of 500 health");
    assert.match(await page.locator("#board").textContent(), /Runner.*31.5/);
    await page.clock.runFor(2_100); // unchanged response is now a 304
    assert.equal(await page.locator("#cheer-btn").isDisabled(), false);
    assert.equal(await page.locator("#me-score").textContent(), "31.5 points");
    assert.ok(headers.includes('"validation-3817"'), "poll sends the previous ETag");
    assert.ok(headers.includes('"validation-3837"'), "unchanged reading is revalidated");
    const calls = await page.evaluate(() => window.__walletCalls);
    assert.equal(calls.filter((c) => c.method === "personal_sign").length, 2);
    assert.equal(calls.some((c) => /sendTransaction|signTransaction/.test(c.method)), false);
    await noOverflow(page);
    await page.screenshot({ path: `${out}/runner-score.png` });
    await page.reload();
    await page.locator("#me").waitFor({ state: "visible" });
    assert.equal(await page.locator("#me-score").textContent(), "31.5 points");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await check("stalled response body times out without caching an unread ETag", async () => {
    const { page, errors } = await freshPage();
    await page.addInitScript(({ api, url }) => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => fetch(input === api ? url : input, init);
    }, { api: API, url: base + "streaming-status" });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector("#wheel-state").textContent === "Idle");
    await Promise.all([page.waitForRequest(base + "streaming-status"), page.clock.runFor(2_100)]);
    assert.equal(streaming.requests, 2);
    await page.clock.runFor(10_100);
    await page.locator("#banner:not([hidden])").waitFor();
    assert.match(await page.locator("#banner").textContent(), /timed out after 10 seconds/);
    await Promise.all([page.waitForRequest(base + "streaming-status"), page.clock.runFor(4_100)]);
    assert.equal(streaming.headers[2], '"completed-body"', "only a fully read status may update the ETag");
    await page.waitForFunction(() => document.querySelector("#hp-text").textContent === "490 of 500 health");
    assert.deepEqual(errors, []);
    await page.close();
  });

  await check("PNG share image is 1200 by 630 and resolves under a subpath", async () => {
    const { page, errors } = await freshPage();
    await page.route(API, (route) => route.fulfill({ json: document() }));
    await page.goto(base);
    const share = await page.locator('meta[property="og:image"]').getAttribute("content");
    assert.equal(share, "./og.png");
    assert.equal(await page.locator('meta[name="twitter:image"]').getAttribute("content"), share);
    const response = await page.request.get(new URL(share, base).href);
    assert.equal(response.headers()["content-type"], "image/png");
    const body = await response.body();
    assert.equal(body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(body.readUInt32BE(16), 1200);
    assert.equal(body.readUInt32BE(20), 630);
    assert.deepEqual(errors, []);
    await page.close();
  });
  await writeFile(`${out}/browser-results.json`, JSON.stringify({ results }, null, 2) + "\n");
  console.log(`${results.length} browser checks passed. Screenshots and results: test/scratch/revision/`);
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
}
