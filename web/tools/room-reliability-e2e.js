/* Fullscreen approvals, reconnect protection, and host TV performance mode. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json" };
function serve(handler) { const server = http.createServer(handler); return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server))); }
async function main() {
  const site = await serve((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  const frameSite = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><style>#native-control{position:fixed;right:8px;bottom:8px}</style><button id="native-control" onclick="this.textContent=\'YouTube control used\'">YouTube control</button>');
  });
  const origin = `http://127.0.0.1:${site.address().port}`;
  const frameUrl = `http://127.0.0.1:${frameSite.address().port}/`;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const hostContext = await browser.newContext({
      viewport: { width: 1280, height: 720 }, serviceWorkers: "block",
      userAgent: "Mozilla/5.0 (Linux; Android 9; Wanbo T2 Max) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36"
    });
    await hostContext.addInitScript(({ frameUrl }) => {
      window.__frameUrl = frameUrl;
      localStorage.setItem("kn:host", JSON.stringify({
        at: Date.now(), code: "ABCDEF", token: "test", rev: 3,
        now: { sid: "now", id: "aaaaaaaaaaa", title: "Playing", duration: 213 }, queue: [],
        config: { joinApproval: true, sounds: false, scoring: true, leaderboard: true, maxRun: false }
      }));
    }, { frameUrl });
    await hostContext.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin && url.origin !== new URL(frameUrl).origin) return route.abort();
      if (url.origin !== origin) return route.continue();
      let extra = "";
      if (url.pathname === "/js/peer.js") extra = `
        (function () {
          var links = [];
          KN.net.host = function (code, opts) {
            window.__hostEvents = opts.on;
            window.__fakeJoin = function (id, name) {
              var link = { id: id, open: true, messages: [], send: function (m) { this.messages.push(m); }, isOpen: function () { return this.open; } };
              links.push(link); opts.on["guest-open"](link); opts.on["guest-message"](link, {type:"HELLO", name:name});
              return link;
            };
            return {token:"test", onlineBrokers:function(){return 1;}, guests:function(){return links.filter(function(l){return l.isOpen();});},
              broadcast:function(){}, stop:function(){}, kick:function(id){links=links.filter(function(l){return l.id!==id;});}};
          };
        })();`;
      if (url.pathname === "/js/player.js") extra = `
        (function () {
          window.__playerCalls = {load:0, play:0, pause:0, stop:0, seek:0, volume:0, mute:0, destroy:0};
          KN.player.create = function (id) {
            var frame = document.createElement("iframe"); frame.id = id; frame.src = window.__frameUrl;
            document.getElementById(id).replaceWith(frame);
            var player = { on:function(){return player;}, load:function(){window.__playerCalls.load++;},
              play:function(){window.__playerCalls.play++;}, pause:function(){window.__playerCalls.pause++;},
              stop:function(){window.__playerCalls.stop++;}, seek:function(){window.__playerCalls.seek++;}, destroy:function(){window.__playerCalls.destroy++;},
              volume:function(){if(arguments.length)window.__playerCalls.volume++;}, mute:function(){if(arguments.length)window.__playerCalls.mute++;}, time:function(){return 0;}, duration:function(){return 213;}, meta:function(){return null;} };
            return Promise.resolve(player);
          };
        })();`;
      if (extra) return route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(path.join(root, url.pathname), "utf8") + extra });
      return route.continue();
    });
    const host = await hostContext.newPage();
    const errors = [];
    host.on("pageerror", e => errors.push(e.message));
    await host.goto(origin + "/#/host");
    await host.waitForFunction(() => !!window.KN.app.player);
    assert.equal(await host.locator("#cfg-tv-performance").isChecked(), true, "older Android enables TV mode");
    assert.equal(await host.evaluate(() => document.body.classList.contains("tv-performance")), true);
    await host.locator("#fs-btn").click();
    await host.waitForFunction(() => document.fullscreenElement === document.getElementById("stage"));
    const before = await host.evaluate(() => JSON.stringify(window.__playerCalls));
    await host.evaluate(() => { window.__alice = window.__fakeJoin("alice", "Alice"); });
    await host.locator("#fs-pending:not([hidden])").waitFor();
    const joinBox = await host.locator("#fs-join").boundingBox();
    const pendingBox = await host.locator("#fs-pending").boundingBox();
    const stageBox = await host.locator("#stage").boundingBox();
    assert.ok(pendingBox.y >= joinBox.y + joinBox.height, "requests do not cover the QR code");
    assert.ok(pendingBox.y + pendingBox.height <= stageBox.y + stageBox.height - 60, "requests leave the embedded controls clear");
    if (process.env.KN_SCREENSHOT_DIR) await host.screenshot({ path: path.join(process.env.KN_SCREENSHOT_DIR, "fullscreen-approvals.png") });
    assert.equal(await host.locator("#fs-pending-list").getByText("Alice").isVisible(), true);
    await host.frameLocator("#yt-frame").getByRole("button", { name: "YouTube control" }).click();
    assert.equal(await host.frameLocator("#yt-frame").getByRole("button", { name: "YouTube control used" }).isVisible(), true);
    await host.locator("#fs-pending-list").getByRole("button", { name: "Let Alice in" }).click();
    assert.equal(await host.evaluate(() => !!window.KN.app.approved.alice), true);
    assert.equal(await host.locator("#fs-pending").isHidden(), true);
    assert.equal(await host.evaluate(() => document.activeElement.id), "fs-btn", "focus returns to fullscreen control when the panel closes");
    await host.evaluate(() => { window.__alice.open = false; window.__bob = window.__fakeJoin("bob", "Bob"); });
    assert.equal(await host.evaluate(() => window.KN.app.state.guests.some(g => g.id === "alice")), false);
    await host.evaluate(() => { window.__alice.open = true; window.__hostEvents["guest-restored"](window.__alice); });
    assert.equal(await host.evaluate(() => window.KN.app.state.guests.some(g => g.id === "alice")), true, "a healed guest is counted again");
    await host.locator("#fs-pending-list").getByRole("button", { name: "Refuse Bob" }).click();
    assert.equal(await host.evaluate(() => window.__bob.messages.some(m => m.type === "BYE" && m.reason === "refused")), true);
    assert.equal(await host.evaluate(() => JSON.stringify(window.__playerCalls)), before, "approval/fullscreen never pause, reload, or destroy playback");
    await host.locator("#fs-btn").click();
    await host.waitForFunction(() => !document.fullscreenElement);
    console.log("  ok   host approves and declines guests in fullscreen without interrupting playback or the embedded control");

    await host.evaluate(() => {
      window.KN.fx.confetti(document.body, { count: 8 });
      window.__probeCues = []; window.__probeDestroyed = 0;
      function Probe(id, options) {
        const mount = document.getElementById(id);
        const frame = document.createElement("iframe"); frame.id = id; mount.replaceWith(frame);
        const self = this;
        this.mute = function () {};
        this.destroy = function () { window.__probeDestroyed++; frame.remove(); };
        this.getVideoData = function () { return { video_id: self.videoId }; };
        this.cueVideoById = function (video) {
          self.videoId = video.videoId; window.__probeCues.push(self.videoId);
          setTimeout(function () { options.events.onStateChange({ data: 5, target: self }); }, 0);
        };
        setTimeout(function () { options.events.onReady({ target: self }); }, 0);
      }
      window.KN.player.loadApi = function () { return Promise.resolve({ Player: Probe }); };
      window.KN.search.karaokeVerdict = function () { return "sure"; };
      window.KN.search.search = function () { return Promise.resolve({ source: "test", results: [
        { id: "bbbbbbbbbbb", title: "First karaoke", author: "A", duration: 210 },
        { id: "ccccccccccc", title: "Second karaoke", author: "B", duration: 210 },
        { id: "ddddddddddd", title: "Third karaoke", author: "C", duration: 210 }
      ] }); };
    });
    assert.equal(await host.locator(".confetti").count(), 0, "TV mode avoids confetti animations");
    await host.locator('.tab[data-tab="search"]').click();
    await host.locator("#q").fill("karaoke test");
    await host.locator("#search-form button[type=submit]").click();
    await host.waitForFunction(() => window.__probeCues.length >= 1);
    await host.waitForTimeout(600);
    assert.equal(await host.evaluate(() => window.__probeCues.length), 1, "TV host checks one video at a time during playback");
    await host.waitForFunction(() => window.KN.app.searchBusy === false, null, { timeout: 15000 });
    assert.equal(await host.evaluate(() => window.__probeCues.length), 3);
    await host.waitForFunction(() => window.__probeDestroyed >= 1 && document.querySelectorAll("#kn-probes iframe").length === 0, null, { timeout: 10000 });
    assert.equal(await host.locator("#yt-frame").count(), 1, "idle-probe cleanup never removes the playing frame");
    assert.equal(await host.evaluate(() => JSON.stringify(window.__playerCalls)), before);
    await host.locator('.tab[data-tab="config"]').click();
    await host.locator("#cfg-tv-performance").uncheck();
    assert.equal(await host.evaluate(() => document.body.classList.contains("tv-performance")), false);
    assert.equal(await host.evaluate(() => localStorage.getItem("kn:tv-performance")), "0");
    await host.reload();
    await host.waitForFunction(() => !!window.KN.app.player);
    assert.equal(await host.locator("#cfg-tv-performance").isChecked(), false, "an explicit opt-out overrides TV detection");
    await host.locator('.tab[data-tab="config"]').click();
    await host.locator("#cfg-tv-performance").check();
    assert.equal(await host.evaluate(() => localStorage.getItem("kn:tv-performance")), "1");
    await host.reload();
    await host.waitForFunction(() => !!window.KN.app.player);
    assert.equal(await host.locator("#cfg-tv-performance").isChecked(), true, "TV preference survives reload");
    console.log("  ok   TV mode reduces background checks and effects, releases idle probes, and preserves playback");

    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await guestContext.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const guest = await guestContext.newPage();
    guest.on("pageerror", e => errors.push(e.message));
    await guest.goto(origin + "/#/r/ABCDEF");
    await guest.locator("#name-gate:not([hidden])").waitFor();
    await guest.evaluate(() => {
      window.KN.net.join = function (code, handlers) {
        const g = window.__guest = { open: false, sent: [], retries: 0, handlers: handlers };
        return { isOpen: function () { return g.open; }, send: function (m) { if (!g.open) return false; g.sent.push(m); return true; },
          retryNow: function () { g.retries++; }, stop: function () { g.open = false; } };
      };
    });
    await guest.locator("#name-gate-input").fill("Singer");
    await guest.locator("#name-gate-form button[type=submit]").click();
    await guest.locator("#guest-reconnect:not([hidden])").waitFor();
    if (process.env.KN_SCREENSHOT_DIR) {
      await guest.waitForTimeout(500);
      await guest.screenshot({ path: path.join(process.env.KN_SCREENSHOT_DIR, "guest-reconnect.png") });
    }
    assert.equal(await guest.locator("#view-room").getAttribute("inert"), "");
    await guest.evaluate(() => document.getElementById("play-btn").click());
    assert.equal(await guest.evaluate(() => window.__guest.sent.length), 0, "offline action is not sent");
    await guest.locator("#guest-retry").click();
    assert.equal(await guest.evaluate(() => window.__guest.retries), 1);
    await guest.evaluate(() => { window.__guest.open = true; window.__guest.handlers.state("connected"); });
    assert.equal(await guest.locator("#guest-reconnect").isVisible(), true, "connection alone is not a fresh room snapshot");
    await guest.evaluate(() => {
      const s = window.KN.room.createState("ABCDEF"); s.rev = 10;
      window.__guest.handlers.message({ type: "STATE", rev: 10, state: s });
    });
    await guest.locator("#guest-reconnect").waitFor({ state: "hidden" });
    await guest.evaluate(() => window.__guest.handlers.checking("wake"));
    assert.equal(await guest.locator("#guest-reconnect").isVisible(), true, "a sleeping channel is verified before accepting actions");
    await guest.evaluate(() => {
      window.__guest.handlers.wake();
      const s = window.KN.room.createState("ABCDEF"); s.rev = 10;
      window.__guest.handlers.message({ type: "STATE", rev: 10, state: s });
    });
    await guest.locator("#guest-reconnect").waitFor({ state: "hidden" });
    await guest.locator("#play-btn").click();
    assert.equal(await guest.evaluate(() => window.__guest.sent.filter(m => m.type === "PLAY").length), 1);
    await guest.evaluate(() => {
      window.KN.search.resolve = function () { return new Promise(resolve => { window.__finishSearch = resolve; }); };
      window.KN.embed.check = function () { return Promise.resolve(window.KN.embed.YES); };
      document.getElementById("q").value = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
      document.getElementById("search-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await guest.waitForFunction(() => typeof window.__finishSearch === "function");
    await guest.evaluate(() => {
      window.__guest.open = false; window.__guest.handlers.closed(); window.__guest.handlers.state("retrying");
      document.getElementById("skip-btn").click();
      const input = document.getElementById("name-input");
      input.value = "Offline name";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await guest.locator("#guest-reconnect:not([hidden])").waitFor();
    assert.equal(await guest.evaluate(() => window.__guest.sent.filter(m => m.type === "SKIP").length), 0);
    assert.equal(await guest.evaluate(() => window.KN.app.name), "Singer", "offline name changes are not applied or queued");
    await guest.evaluate(() => { window.__guest.open = true; window.__guest.handlers.state("connected"); });
    assert.equal(await guest.locator("#guest-reconnect").isVisible(), true);
    await guest.evaluate(() => {
      const s = window.KN.room.createState("ABCDEF"); s.rev = 1;
      window.__guest.handlers.message({ type: "STATE", rev: 1, state: s });
    });
    await guest.locator("#guest-reconnect").waitFor({ state: "hidden" });
    assert.equal(await guest.evaluate(() => window.KN.app.state.rev), 1, "first snapshot after reconnect replaces stale state");
    await guest.evaluate(() => window.__finishSearch({ id: "aaaaaaaaaaa", title: "Delayed song" }));
    await guest.waitForTimeout(100);
    assert.equal(await guest.evaluate(() => window.__guest.sent.filter(m => m.type === "ADD").length), 0, "an interrupted search cannot add a song after reconnection");
    assert.equal(await guest.evaluate(() => window.__guest.sent.filter(m => m.type === "SKIP").length), 0, "blocked action is not replayed");
    await guest.evaluate(() => {
      window.__online = false; Object.defineProperty(navigator, "onLine", { configurable: true, get: () => window.__online });
      window.dispatchEvent(new Event("offline"));
    });
    await guest.locator("#guest-reconnect:not([hidden])").waitFor();
    await guest.evaluate(() => { window.__online = true; window.dispatchEvent(new Event("online")); });
    assert.equal(await guest.locator("#guest-reconnect").isVisible(), true, "online needs a fresh snapshot");
    await guest.evaluate(() => {
      const s = window.KN.room.createState("ABCDEF"); s.rev = 2;
      window.__guest.handlers.message({ type: "STATE", rev: 2, state: s });
    });
    await guest.locator("#guest-reconnect").waitFor({ state: "hidden" });
    await guest.evaluate(() => { window.__guest.open = false; window.__guest.handlers.closed(); });
    await guest.locator("#guest-leave").click();
    assert.equal(await guest.locator("#view-home").isVisible(), true);
    assert.equal(await guest.locator("#guest-reconnect").isHidden(), true);
    await guest.evaluate(() => { location.hash = "#/r/ABCDEF"; });
    await guest.locator("#name-gate:not([hidden])").waitFor();
    await guest.locator("#name-gate-form button[type=submit]").click();
    await guest.evaluate(() => {
      window.__guest.open = true; window.__guest.handlers.state("connected");
      const s = window.KN.room.createState("ABCDEF");
      window.__guest.handlers.message({ type: "STATE", rev: 0, state: s });
    });
    await guest.locator("#guest-reconnect").waitFor({ state: "hidden" });
    await guest.evaluate(() => { location.hash = "#/r/ZZZZZZ"; });
    await guest.locator("#name-gate:not([hidden])").waitFor();
    assert.equal(await guest.locator("#guest-reconnect").isHidden(), true, "joining another room clears the old guard");
    await guest.locator("#name-gate-input").fill("New singer");
    await guest.locator("#name-gate-form button[type=submit]").click();
    assert.equal(await guest.evaluate(() => window.KN.app.name), "New singer");
    assert.equal(await guest.evaluate(() => window.KN.app.state.code), "ZZZZZZ");
    assert.equal(await guest.evaluate(() => location.hash), "#/r/ZZZZZZ");
    assert.deepEqual(errors, []);
    console.log("  ok   guests cannot send or replay actions offline; reconnect requires fresh state and Leave stays available");
  } finally {
    if (browser) await browser.close();
    await Promise.all([new Promise(r => site.close(r)), new Promise(r => frameSite.close(r))]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
