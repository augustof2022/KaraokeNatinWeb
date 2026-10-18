/* Playback clocks should not rebuild the room or write unchanged storage.
 * Uses real elapsed ticker intervals with a local player and transport stand-in;
 * no YouTube connection or local WebRTC access is needed.
 * Run: node tools/playback-performance-e2e.js
 */
"use strict";

const assert = require("assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const NET_STUB = `
(function () {
  window.__snapshots = [];
  var link = {
    id: "local-observer",
    send: function (message) {
      if (message.type === "STATE") window.__snapshots.push(JSON.parse(JSON.stringify(message)));
    }
  };
  KN.net.host = function (code, opts) {
    window.__hostEvents = opts.on;
    window.__guestLink = link;
    return {
      token: "local-test-token", onlineBrokers: function () { return 1; },
      guests: function () { return [link]; }, stop: function () {}, broadcast: function () {}
    };
  };
})();
`;

const PLAYER_STUB = `
(function () {
  KN.player.create = function (elementId) {
    var handlers = {};
    var started = performance.now();
    var frozen = null;
    var volume = 80, muted = false;
    var mount = document.getElementById(elementId);
    var frame = document.createElement("iframe");
    frame.id = elementId;
    mount.replaceWith(frame);
    function emit(name) { (handlers[name] || []).forEach(function (fn) { fn(); }); }
    var player = {
      on: function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); return player; },
      load: function () { setTimeout(function () { emit("playing"); }, 0); },
      play: function () { emit("playing"); }, pause: function () { emit("paused"); },
      seek: function () {}, stop: function () {}, destroy: function () {},
      volume: function (value) { if (!arguments.length) return volume; volume = value; },
      mute: function (value) { if (!arguments.length) return muted; muted = value; },
      time: function () { return frozen === null ? 10 + (performance.now() - started) / 1000 : frozen; },
      duration: function () { return 213; },
      meta: function () { return { duration: 213, title: "Current song", author: "Test" }; },
      freeze: function () { frozen = player.time(); },
      nativeSound: function (value, muteValue) { volume = value; muted = muteValue; }
    };
    window.__playback = player;
    return Promise.resolve(player);
  };
})();
`;

async function main() {
  const site = await serve();
  const origin = `http://127.0.0.1:${site.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const context = await browser.newContext({ serviceWorkers: "block", reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const stub = url.pathname === "/js/peer.js" ? NET_STUB : url.pathname === "/js/player.js" ? PLAYER_STUB : null;
      if (stub) {
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: fs.readFileSync(path.join(ROOT, url.pathname), "utf8") + "\n" + stub
        });
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      localStorage.setItem("kn:host", JSON.stringify({
        at: Date.now(), code: "ABCDEF", token: "local-test-token", rev: 10,
        now: { sid: "current", id: "aaaaaaaaaaa", title: "Current song", duration: 213 },
        queue: [
          { sid: "queued-one", id: "bbbbbbbbbbb", title: "Queued song", duration: 213, addedBy: "Host" },
          { sid: "queued-two", id: "ccccccccccc", title: "Another queued song", duration: 213, addedBy: "Host" }
        ],
        scores: [{ name: "Host", score: 90, title: "Earlier song", at: Date.now(), band: "good" }],
        config: { joinApproval: false, sounds: false, scoring: true, leaderboard: true, maxRun: false }
      }));
      // Avoid a time-of-day curfew popup interfering with a real-clock test.
      const today = new Date();
      localStorage.setItem("kn:curfew", today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate());
      const originalSetItem = Storage.prototype.setItem;
      window.__hostWrites = 0;
      Storage.prototype.setItem = function (key, value) {
        if (key === "kn:host") window.__hostWrites++;
        return originalSetItem.call(this, key, value);
      };
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/index.html#/host");
    await page.waitForFunction(() => KN.app.player && KN.app.state.player.status === "playing");
    assert.equal(await page.locator("#queue .row").count(), 2);
    assert.equal(await page.locator("#board .board-row").count(), 1);

    await page.evaluate(() => {
      window.__hostWrites = 0;
      window.__snapshots = [];
      window.__startRev = KN.app.state.rev;
      window.__queueRow = document.querySelector("#queue .row");
      window.__scoreRow = document.querySelector("#board .board-row");
      window.__queueMutations = 0;
      window.__scoreMutations = 0;
      new MutationObserver((records) => { window.__queueMutations += records.length; })
        .observe(document.querySelector("#queue"), { childList: true, subtree: true });
      new MutationObserver((records) => { window.__scoreMutations += records.length; })
        .observe(document.querySelector("#board"), { childList: true, subtree: true });
    });

    // Four actual ticks cover both a transmitted snapshot and throttled ticks.
    await page.waitForFunction(() => KN.app.state.player.time >= 14, null, { timeout: 10000 });
    await page.evaluate(() => window.__playback.freeze());
    // With the clock now still, the pending quiet callback has to deliver its
    // last snapshot. This also verifies playbackOnly survives that callback.
    await page.waitForFunction(() => window.__snapshots.length >= 2, null, { timeout: 7000 });
    const progress = await page.evaluate(() => ({
      queueSame: window.__queueRow === document.querySelector("#queue .row"),
      scoreSame: window.__scoreRow === document.querySelector("#board .board-row"),
      queueMutations: window.__queueMutations, scoreMutations: window.__scoreMutations,
      writes: window.__hostWrites,
      clock: document.querySelector("#t-now").textContent,
      rev: KN.app.state.rev, initialRev: window.__startRev,
      times: window.__snapshots.map((message) => message.state.player.time)
    }));
    assert.equal(progress.queueSame, true, "playback ticks preserve queue nodes");
    assert.equal(progress.scoreSame, true, "playback ticks preserve score nodes");
    assert.equal(progress.queueMutations, 0, "playback ticks do not rebuild queue DOM");
    assert.equal(progress.scoreMutations, 0, "playback ticks do not rebuild score DOM");
    assert.equal(progress.writes, 0, "playback ticks do not save unchanged room data");
    assert.match(progress.clock, /^0:1[4-9]$/, "host progress advances");
    assert.equal(progress.rev, progress.initialRev, "clock ticks preserve command revision");
    assert.ok(progress.times.at(-1) > progress.times[0], "guest snapshots keep advancing, including the delayed snapshot");
    console.log("  ok   real playback ticks and delayed snapshots preserve room DOM and storage");

    // An actual queue edit must still be rendered and saved immediately.
    await page.locator('#queue .row').first().getByRole("button", { name: "Remove", exact: true }).click();
    assert.equal(await page.locator("#queue .row").count(), 1);
    const savedQueue = await page.evaluate(() => JSON.parse(localStorage.getItem("kn:host")).queue);
    assert.equal(savedQueue.length, 1);
    assert.equal(savedQueue[0].sid, "queued-two");
    assert.ok(await page.evaluate(() => window.__hostWrites > 0));
    console.log("  ok   real queue edits still render and persist");

    // NAME uses progress:true but carries metadata. It must retain a full
    // render even though it does not increment the command revision.
    await page.evaluate(() => {
      window.__beforeNameWrites = window.__hostWrites;
      window.__beforeNameRev = KN.app.state.rev;
      window.__hostEvents["guest-message"](window.__guestLink, { type: "NAME", name: "Renamed singer" });
    });
    assert.match(await page.locator("#singers").textContent(), /Renamed singer/);
    assert.equal(await page.evaluate(() => KN.app.state.rev === window.__beforeNameRev), true);
    assert.equal(await page.evaluate(() => window.__hostWrites > window.__beforeNameWrites), true);
    console.log("  ok   non-ticker progress metadata still renders and persists");

    // Native YouTube volume/mute adjustments should be reflected by the
    // room's own controls and delivered in the next guest snapshot.
    await page.evaluate(() => {
      window.__beforeSoundWrites = window.__hostWrites;
      window.__playback.nativeSound(35, true);
    });
    await page.waitForFunction(() => KN.app.state.player.volume === 35 && KN.app.state.player.muted === true);
    assert.equal(await page.locator("#vol").inputValue(), "35");
    assert.equal(await page.locator("#mute-btn").getAttribute("aria-pressed"), "true");
    const sound = await page.evaluate(() => ({
      wrote: window.__hostWrites > window.__beforeSoundWrites,
      player: window.__snapshots.at(-1).state.player
    }));
    assert.equal(sound.wrote, true);
    assert.equal(sound.player.volume, 35);
    assert.equal(sound.player.muted, true);
    console.log("  ok   native sound changes synchronize room controls and guest state");
    assert.deepEqual(pageErrors, [], "no browser errors");
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => site.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
