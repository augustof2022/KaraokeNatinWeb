/* tools/youtube-setup-e2e.js — optional YouTube account guidance.
 *
 * Exercises the actual home and room routes without signing in to YouTube or
 * depending on an external service. A local broker registers the host, and
 * the sign-in shortcut opens a synthetic YouTube page. Guest transport is a
 * no-op: host-only guidance must stay hidden even without a WebRTC connection.
 *
 * Run: node tools/youtube-setup-e2e.js
 */
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const broker = require("./broker");

const ROOT = path.resolve(__dirname, "..");
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

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

async function roomSnapshot(page) {
  return page.evaluate(() => {
    const state = window.KN.app.state;
    return JSON.parse(JSON.stringify({
      code: state.code,
      queue: state.queue,
      now: state.now,
      config: state.config,
      player: state.player
    }));
  });
}

async function checkPanel(page, selector, label, openShortcut) {
  const panel = page.locator(selector);
  const summary = panel.locator("summary");
  check(label + " guidance starts collapsed", await panel.evaluate((node) => node.open), false);
  check(label + " has an optional account summary", (await summary.textContent()).trim(), "YouTube account (optional)");

  await summary.focus();
  await page.keyboard.press("Enter");
  check(label + " guidance expands with the keyboard", await panel.evaluate((node) => node.open));
  const guidance = await panel.innerText();
  check(label + " explains use of the same browser profile", /same browser profile/i.test(guidance));
  check(label + " avoids promising ad-free playback", /ad-free playback is not guaranteed/i.test(guidance));

  const shortcut = panel.locator("a.youtube-sign-in");
  check(label + " shortcut goes directly to YouTube", await shortcut.getAttribute("href"), "https://www.youtube.com/");
  check(label + " shortcut opens a separate tab", await shortcut.getAttribute("target"), "_blank");
  const rel = (await shortcut.getAttribute("rel") || "").split(/\s+/);
  check(label + " shortcut protects the host tab", rel.includes("noopener") && rel.includes("noreferrer"));

  if (openShortcut) {
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      shortcut.click()
    ]);
    await popup.waitForLoadState("domcontentloaded");
    check(label + " opens the expected sign-in destination", popup.url(), "https://www.youtube.com/");
    check(label + " new tab has no window opener", await popup.evaluate(() => window.opener === null));
    check(label + " stays expanded while YouTube is open", await panel.evaluate((node) => node.open));
    await popup.close();
  }

  await panel.locator("button[data-youtube-skip]").click();
  check(label + " Skip closes the guidance", await panel.evaluate((node) => node.open), false);
  check(label + " Skip returns keyboard focus to the summary", await summary.evaluate((node) => document.activeElement === node));
  await page.keyboard.press("Enter");
  check(label + " can reopen after Skip", await panel.evaluate((node) => node.open));
  await panel.locator("button[data-youtube-skip]").click();
}

async function main() {
  let site;
  let localBroker;
  let browser;
  const errors = [];
  try {
    site = await serve();
    localBroker = await broker.start(0);
    const base = "http://127.0.0.1:" + site.address().port + "/index.html";
    browser = await chromium.launch({ args: ["--no-sandbox"] });

    async function newContext(viewport) {
      // Blocking workers lets the route policy account for every HTTP request.
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });
      await context.addInitScript((port) => {
        window.KN_BROKERS = [{ host: "127.0.0.1", port, path: "/", key: "peerjs" }];
      }, localBroker.port);
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "127.0.0.1") return route.continue();
        if (url.href === "https://www.youtube.com/") {
          return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>YouTube sign-in shortcut test</title>" });
        }
        return route.abort();
      });
      context.on("page", (page) => {
        page.setDefaultTimeout(10000);
        page.on("pageerror", (error) => errors.push(error.message));
      });
      return context;
    }

    for (const [label, viewport] of [
      ["desktop", { width: 1280, height: 800 }],
      ["mobile", { width: 390, height: 844 }]
    ]) {
      const context = await newContext(viewport);
      const page = await context.newPage();
      await page.goto(base);
      await checkPanel(page, "#youtube-setup-home", label + " home", true);
      check(label + " Skip leaves the home screen available", await page.locator("#view-home").isVisible());
      check(label + " guidance creates no YouTube iframe or room", await page.evaluate(() =>
        document.querySelectorAll("iframe").length === 0 && window.KN.app.role === null));

      await page.click("#host-btn");
      await page.waitForSelector("#view-room:not([hidden])");
      const code = (await page.textContent("#room-code")).trim();
      check(label + " starts a room after skipping sign-in", /^[A-Z0-9]{6}$/.test(code));
      await page.click('[data-tab="config"]');
      const beforeSkip = await roomSnapshot(page);
      await checkPanel(page, "#youtube-setup-room", label + " host room", false);
      check(label + " room Skip preserves code, queue, configuration and player", await roomSnapshot(page), beforeSkip);
      await context.close();
    }

    const directContext = await newContext({ width: 1280, height: 800 });
    const direct = await directContext.newPage();
    await direct.goto(base + "#/host");
    await direct.waitForSelector("#view-room:not([hidden])");
    check("direct host route starts without an account setup gate", await direct.evaluate(() => window.KN.app.role), "host");
    const code = (await direct.textContent("#room-code")).trim();
    await direct.reload();
    await direct.waitForSelector("#view-room:not([hidden])");
    check("reloading a host preserves its room code without account setup", (await direct.textContent("#room-code")).trim(), code);

    const guestContext = await newContext({ width: 390, height: 844 });
    const guest = await guestContext.newPage();
    await guest.goto(base + "#/r/" + code);
    await guest.waitForSelector("#name-gate:not([hidden])");
    check("guest join route does not show the host account panel", await guest.locator("#youtube-setup-room").isVisible(), false);
    // Test role-specific UI through the real name gate without starting ICE.
    await guest.evaluate(() => {
      window.KN.net.join = function () {
        return { send: function () {}, stop: function () {}, retryNow: function () {} };
      };
    });
    await guest.fill("#name-gate-input", "Guest singer");
    await guest.click("#name-gate-form button[type=submit]");
    await guest.waitForSelector("#view-room:not([hidden])");
    check("guest route enters the guest role", await guest.evaluate(() => window.KN.app.role), "guest");
    // Reveal the enclosing tab panel so its hidden state cannot mask a broken
    // host-only rule (co-hosts may legitimately access this tab as well).
    await guest.locator('[data-panel="config"]').evaluate((node) => { node.hidden = false; });
    check("account guidance itself stays hidden for guests", await guest.locator("#youtube-setup-room").isVisible(), false);
    check("all scenarios finish without JavaScript errors", errors, []);
    console.log("\nYouTube account guidance checks passed");
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
