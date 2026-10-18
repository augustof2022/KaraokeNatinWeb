/* tools/leave-room-e2e.js — room exit without browser-native dialogs.
 *
 * Tests host confirmation, keyboard access, repeat hosting, guest exit, and
 * delayed YouTube startup. Every external request is blocked; player promises
 * are controlled by the test so leaving during startup is deterministic.
 *
 * Run: node tools/leave-room-e2e.js
 */
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const broker = require("./broker");

const ROOT = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

function serve() {
  const server = http.createServer((req, res) => {
    const requested = decodeURIComponent(req.url.split("?")[0]);
    const file = path.resolve(ROOT, "." + (requested === "/" ? "/index.html" : requested));
    const relative = path.relative(ROOT, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) ||
        !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function check(name, actual, expected = true) {
  assert.deepEqual(actual, expected, name);
  console.log("  ok   " + name);
}

async function stubPlayer(page) {
  await page.evaluate(() => {
    window.__playerRequests = [];
    window.KN.player.create = function () {
      const request = { destroyed: 0 };
      const player = {
        on: function () { return player; },
        volume: function () {}, mute: function () {}, load: function () {},
        play: function () {}, pause: function () {}, stop: function () {},
        seek: function () {}, time: function () { return 0; },
        duration: function () { return 0; }, meta: function () { return null; },
        destroy: function () { request.destroyed++; }
      };
      request.player = player;
      window.__playerRequests.push(request);
      return new Promise((resolve, reject) => {
        request.resolve = function () { resolve(player); };
        request.reject = function () { reject(new Error("Delayed YouTube startup failure")); };
      });
    };
  });
}

async function startHost(page) {
  await page.click("#host-btn");
  await page.waitForSelector("#view-room:not([hidden])");
  return page.evaluate(() => window.KN.app.state.code);
}

async function confirmClose(page) {
  await page.click("#leave-btn");
  await page.waitForSelector("#leave-room-confirm:not([hidden])");
  await page.click("#leave-room-close");
  await page.waitForSelector("#view-home:not([hidden])");
}

async function assertHome(page, label) {
  check(label + " returns to the home route", await page.evaluate(() => location.hash), "#/");
  check(label + " clears active room and saved resume state", await page.evaluate(() => ({
    role: window.KN.app.role,
    state: window.KN.app.state,
    net: window.KN.app.net,
    player: window.KN.app.player,
    host: localStorage.getItem("kn:host"),
    guest: localStorage.getItem("kn:guest")
  })), { role: null, state: null, net: null, player: null, host: null, guest: null });
  check(label + " ends the statistics session", await page.evaluate(() => {
    const stats = JSON.parse(localStorage.getItem("kn:stats"));
    return stats.current === null && stats.sessions[0].endedAt > 0;
  }));
  check(label + " offers no room to resume", await page.locator("#resume").isVisible(), false);
}

async function main() {
  let site, localBroker, browser;
  const errors = [];
  try {
    site = await serve();
    localBroker = await broker.start(0);
    const base = "http://127.0.0.1:" + site.address().port + "/index.html";
    browser = await chromium.launch({ args: ["--no-sandbox"] });

    async function newPage(viewport, realPlayer = false) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });
      await context.addInitScript((port) => {
        window.KN_BROKERS = [{ host: "127.0.0.1", port, path: "/", key: "peerjs" }];
        window.__nativeConfirmCalls = 0;
        window.confirm = function () {
          window.__nativeConfirmCalls++;
          throw new Error("Room exit must not depend on window.confirm");
        };
      }, localBroker.port);
      await context.route("**/*", (route) => {
        if (realPlayer && route.request().url() === "https://www.youtube.com/iframe_api") {
          // Keep the real wrapper's shared API promise pending until the test
          // explicitly supplies YouTube's API and fires its ready callback.
          return route.fulfill({ status: 200, contentType: "text/javascript", body: "/* API intentionally delayed */" });
        }
        return new URL(route.request().url()).hostname === "127.0.0.1"
          ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base);
      if (!realPlayer) await stubPlayer(page);
      return page;
    }

    for (const [label, viewport] of [
      ["desktop", { width: 1280, height: 800 }],
      ["mobile", { width: 390, height: 844 }]
    ]) {
      const page = await newPage(viewport);
      check(label + " close confirmation starts hidden", await page.locator("#leave-room-confirm").isVisible(), false);
      const code = await startHost(page);
      await page.click("#leave-btn");
      const dialog = page.getByRole("dialog", { name: "Close this room?", exact: true });
      await dialog.waitFor();
      check(label + " host Leave shows an accessible confirmation", await dialog.isVisible());
      check(label + " cancel is clearly labelled", await page.locator("#leave-room-cancel").textContent(), "Keep room open");
      check(label + " close is clearly labelled", await page.locator("#leave-room-close").textContent(), "Close room");

      await page.locator("#leave-room-close").focus();
      await page.keyboard.press("Tab");
      check(label + " Tab stays inside confirmation", await page.locator("#leave-room-cancel").evaluate((node) => document.activeElement === node));
      await page.keyboard.press("Shift+Tab");
      check(label + " Shift+Tab stays inside confirmation", await page.locator("#leave-room-close").evaluate((node) => document.activeElement === node));

      await page.click("#leave-room-cancel");
      check(label + " cancel preserves the open room", await page.evaluate(() => window.KN.app.state.code), code);
      check(label + " cancel returns focus to Leave", await page.locator("#leave-btn").evaluate((node) => document.activeElement === node));
      check(label + " cancel hides confirmation", await dialog.isVisible(), false);

      await page.click("#leave-btn");
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      check(label + " Escape preserves the room and restores focus", await page.evaluate((expected) =>
        window.KN.app.state.code === expected && document.activeElement.id === "leave-btn" &&
        document.querySelector("#leave-room-confirm").hidden, code));

      await page.click("#leave-btn");
      await dialog.waitFor();
      await page.locator("#leave-room-confirm").click({ position: { x: 4, y: 4 } });
      check(label + " backdrop dismisses without closing the room", await page.evaluate((expected) =>
        window.KN.app.state.code === expected && document.activeElement.id === "leave-btn" &&
        document.querySelector("#leave-room-confirm").hidden, code));

      await confirmClose(page);
      await assertHome(page, label + " host close");

      await page.evaluate(() => window.__playerRequests[0].resolve());
      await page.waitForFunction(() => window.__playerRequests[0].destroyed === 1);
      check(label + " late player completion is destroyed without restoring the room", await page.evaluate(() =>
        window.KN.app.role === null && window.KN.app.player === null && document.querySelector("#view-room").hidden));

      await startHost(page);
      await page.evaluate(() => window.__playerRequests[1].resolve());
      await page.waitForFunction(() => window.KN.app.player === window.__playerRequests[1].player);
      await confirmClose(page);
      await assertHome(page, label + " second host close");
      check(label + " second close destroys the active player once", await page.evaluate(() => window.__playerRequests[1].destroyed), 1);
      check(label + " hosting never invokes a native confirmation", await page.evaluate(() => window.__nativeConfirmCalls), 0);
      await page.context().close();
    }

    const rejected = await newPage({ width: 1280, height: 800 });
    await startHost(rejected);
    await confirmClose(rejected);
    await rejected.evaluate(() => window.__playerRequests[0].reject());
    // A browser task boundary lets the promise rejection handler finish.
    await rejected.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    check("late player rejection leaves home free of player errors", await rejected.evaluate(() =>
      window.KN.app.role === null && window.KN.app.player === null && !document.querySelector(".player-error")));
    await assertHome(rejected, "late player rejection");

    await startHost(rejected);
    await rejected.evaluate(() => {
      const request = window.__playerRequests[1];
      request.player.destroy = function () {
        request.destroyed++;
        throw new Error("YouTube player cleanup failed");
      };
      request.resolve();
    });
    await rejected.waitForFunction(() => window.KN.app.player === window.__playerRequests[1].player);
    await confirmClose(rejected);
    await assertHome(rejected, "failed player cleanup");
    check("a player cleanup failure is attempted once without stranding the host", await rejected.evaluate(() =>
      window.__playerRequests[1].destroyed), 1);

    // A player from the previous room must not attach to a newly opened one.
    await startHost(rejected);
    await confirmClose(rejected);
    const replacementCode = await startHost(rejected);
    await rejected.evaluate(() => window.__playerRequests[2].resolve());
    await rejected.waitForFunction(() => window.__playerRequests[2].destroyed === 1);
    check("late completion from an earlier room preserves the new room", await rejected.evaluate((expected) =>
      window.KN.app.role === "host" && window.KN.app.state.code === expected && window.KN.app.player === null,
    replacementCode));
    await rejected.evaluate(() => window.__playerRequests[3].resolve());
    await rejected.waitForFunction(() => window.KN.app.player === window.__playerRequests[3].player);
    await confirmClose(rejected);

    // Use the actual player wrapper here: two room setups share one pending
    // API load and the same DOM mount ID. Cancellation must happen before a
    // stale setup constructs a YouTube player on the replacement room's mount.
    const delayedApi = await newPage({ width: 1280, height: 800 }, true);
    await startHost(delayedApi);
    await delayedApi.waitForFunction(() => typeof window.onYouTubeIframeAPIReady === "function");
    await confirmClose(delayedApi);
    const liveCode = await startHost(delayedApi);
    await delayedApi.evaluate(() => {
      window.__canceledCreation = window.KN.player.create("yt-frame", function () { return false; });
      window.__ytConstructed = 0;
      window.__ytDestroyed = 0;
      window.YT = {
        Player: function (elementId, options) {
          window.__ytConstructed++;
          const mount = document.getElementById(elementId);
          if (!mount) throw new Error("YouTube constructor lost the current room mount");
          const frame = document.createElement("iframe");
          frame.id = elementId;
          frame.dataset.playerNumber = String(window.__ytConstructed);
          mount.replaceWith(frame);
          this.setVolume = function () {};
          this.mute = function () {};
          this.unMute = function () {};
          this.getCurrentTime = function () { return 0; };
          this.getDuration = function () { return 0; };
          this.destroy = function () { window.__ytDestroyed++; frame.remove(); };
          setTimeout(function () { options.events.onReady(); }, 0);
        }
      };
      window.onYouTubeIframeAPIReady();
    });
    await delayedApi.waitForFunction(() => window.KN.app.player !== null);
    check("shared delayed API constructs only the current room player", await delayedApi.evaluate(() =>
      window.__ytConstructed), 1);
    check("canceled wrapper creation returns null without constructing a player", await delayedApi.evaluate(async () =>
      (await window.__canceledCreation) === null));
    check("stale API setup leaves the replacement room and player frame intact", await delayedApi.evaluate((expected) =>
      window.KN.app.state.code === expected && window.__ytDestroyed === 0 &&
      document.querySelector("#yt-frame").dataset.playerNumber === "1", liveCode));
    await confirmClose(delayedApi);
    check("closing the replacement room destroys its sole player", await delayedApi.evaluate(() =>
      ({ constructed: window.__ytConstructed, destroyed: window.__ytDestroyed })), { constructed: 1, destroyed: 1 });
    await assertHome(delayedApi, "delayed shared API room close");

    const guest = await newPage({ width: 390, height: 844 });
    await guest.evaluate(() => {
      window.__guestStops = 0;
      localStorage.setItem("kn:name", "Leaving guest");
      window.KN.net.join = function () {
        return {
          send: function () {}, isOpen: function () { return true; },
          stop: function () { window.__guestStops++; }, retryNow: function () {}
        };
      };
      location.hash = "#/r/ABCDEF";
    });
    await guest.waitForSelector("#name-gate:not([hidden])");
    await guest.fill("#name-gate-input", "Leaving guest");
    await guest.click("#name-gate-form button[type=submit]");
    await guest.waitForSelector("#view-room:not([hidden])");
    check("guest starts an active statistics session", await guest.evaluate(() =>
      JSON.parse(localStorage.getItem("kn:stats")).current !== null));
    await guest.click("#leave-btn");
    await guest.waitForSelector("#view-home:not([hidden])");
    await assertHome(guest, "guest Leave");
    check("guest Leave stops the connection immediately", await guest.evaluate(() => window.__guestStops), 1);
    check("guest Leave displays no confirmation", await guest.locator("#leave-room-confirm").isVisible(), false);
    check("guest Leave never invokes a native confirmation", await guest.evaluate(() => window.__nativeConfirmCalls), 0);

    check("all exit scenarios finish without JavaScript errors", errors, []);
    console.log("\nRoom exit checks passed");
  } finally {
    if (browser) await browser.close();
    if (localBroker) {
      for (const peer of localBroker.peers.values()) peer.socket.destroy();
      await new Promise((resolve) => localBroker.server.close(resolve));
    }
    if (site) await new Promise((resolve) => site.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
