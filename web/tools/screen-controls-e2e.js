/* Screen overlay behavior with a local player stand-in. Fullscreen geometry is
 * checked with the same body flag because managed Chromium can forbid fullscreen. */
"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const NET = `KN.net.host = function () { return { token: 'test', onlineBrokers: function () { return 1; }, guests: function () { return []; }, stop: function () {}, broadcast: function () {} }; };`;
const PLAYER = `KN.player.create = function () {
  var events = {}, volume = 80, muted = false;
  function emit(name) { (events[name] || []).forEach(function (f) { f(); }); }
  var player = {
    on: function (name, fn) { (events[name] = events[name] || []).push(fn); return player; },
    load: function () { setTimeout(function () { emit('playing'); }, 0); },
    play: function () { emit('playing'); }, pause: function () { emit('paused'); },
    seek: function () {}, stop: function () {}, destroy: function () {},
    time: function () { return 30; }, duration: function () { return 240; },
    meta: function () { return { duration: 240 }; },
    volume: function (v) { if (arguments.length) volume = v; return volume; },
    mute: function (v) { if (arguments.length) muted = v; return muted; }
  };
  return Promise.resolve(player);
};`;

async function main() {
  const site = http.createServer((req, res) => {
    const rel = req.url.split("?")[0].replace(/^\/+/, "") || "index.html";
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + site.address().port;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, serviceWorkers: "block" });
    const errors = [];
    context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      const stub = url.pathname === "/js/peer.js" ? NET : url.pathname === "/js/player.js" ? PLAYER : null;
      if (!stub) return route.continue();
      return route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(path.join(ROOT, url.pathname), "utf8") + "\n" + stub });
    });
    await context.addInitScript((origin) => {
      if (location.origin !== origin) return;
      const d = new Date();
      localStorage.setItem("kn:curfew", d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate());
      localStorage.setItem("kn:host", JSON.stringify({
        at: Date.now(), code: "ABC234", token: "test", queue: [],
        now: { sid: "one", id: "aaaaaaaaaaa", title: "Test song", duration: 240 },
        config: { sounds: false, scoring: false }
      }));
    }, base);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(base + "/#/host");
    await page.waitForFunction(() => KN.app.state.player.status === "playing");
    assert.equal(await page.locator("#stage-controls #transport").count(), 1);
    const stage = await page.locator("#stage").boundingBox();
    const button = await page.locator("#fs-btn").boundingBox();
    assert.ok(button.y > stage.y + stage.height / 2, "fullscreen button is in the bottom half");
    await page.waitForSelector("#stage-controls.stage-controls-hidden", { state: "attached" });
    assert.equal(await page.locator("#stage-controls").evaluate((n) => n.inert), true);
    console.log("  ok   controls sit at the bottom and hide after playback inactivity");
    await page.mouse.move(stage.x + stage.width / 2, stage.y + 20);
    await page.waitForSelector("#stage-controls:not(.stage-controls-hidden)");
    await page.evaluate(() => KN.app.player.pause());
    await page.waitForTimeout(3300);
    assert.equal(await page.locator("#stage-controls").isVisible(), true);
    console.log("  ok   pointer interaction reveals controls and pausing keeps them visible");
    await page.click("#play-btn");
    await page.waitForSelector("#stage-controls.stage-controls-hidden", { state: "attached" });
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#stage-controls").isVisible(), false);
    console.log("  ok   resuming playback hides even mouse-focused controls again");
    await page.locator("#stage").focus();
    await page.waitForSelector("#stage-controls:not(.stage-controls-hidden)");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(3300);
    assert.equal(await page.locator("#stage-controls").isVisible(), true);
    assert.equal(await page.locator("#stage-controls").evaluate((n) => n.contains(document.activeElement)), true);
    console.log("  ok   keyboard-focused controls stay visible and usable");
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForSelector("#stage-controls.stage-controls-hidden", { state: "attached" });
    await page.touchscreen.tap(stage.x + 2, stage.y + 20);
    await page.waitForSelector("#stage-controls:not(.stage-controls-hidden)");
    console.log("  ok   touching the screen reveals controls");
    await page.evaluate(() => { document.body.classList.add("stage-fullscreen"); KN.app.player.pause(); });
    const join = await page.locator("#fs-join").boundingBox();
    assert.ok(join && join.y < stage.y + stage.height / 2 && join.x > stage.x + stage.width / 2, "room QR stays at the top right");
    assert.equal(await page.locator("#fs-join").evaluate((n) => getComputedStyle(n).pointerEvents), "none");
    assert.equal(await page.locator("#fs-join").evaluate((n) => { const r=n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), false, "QR does not intercept player clicks");
    assert.equal(await page.locator("#qr-fs").isVisible(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const mobile = await page.locator("#stage-controls").boundingBox();
    assert.ok(mobile.x >= 0 && mobile.x + mobile.width <= 390, "mobile overlay fits horizontally");
    assert.equal(await page.locator("#qr-fs").isVisible(), true);
    assert.equal(await page.locator("#play-btn").isVisible(), true);
    console.log("  ok   QR stays at the top right without blocking clicks; bottom controls fit mobile");
    await page.evaluate(() => { document.body.classList.remove("stage-fullscreen"); KN.app.player.play(); });
    await page.click("#leave-btn"); await page.click("#leave-room-close");
    await page.waitForSelector("#view-home:not([hidden])");
    await page.fill("#join-name", "Guest"); await page.fill("#join-code", "XYZ234");
    await page.click("#join-form button");
    await page.click("#name-gate-form button[type=submit]");
    await page.waitForSelector("#view-room:not([hidden])");
    assert.equal(await page.locator("#transport-home #transport").count(), 1);
    assert.equal(await page.locator("#transport").isVisible(), true);
    console.log("  ok   guests keep their normal playback controls below the room");
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((r) => site.close(r));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
