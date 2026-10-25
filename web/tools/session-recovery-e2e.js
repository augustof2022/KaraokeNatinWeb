/* Browser lifecycle/storage checks with a stand-in transport. Direct WebRTC
 * integration remains in e2e.js and reconnect-e2e.js. */
"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const broker = require("./broker");
const ROOT = path.resolve(__dirname, "..");

async function main() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const local = await broker.start(0);
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const context = await browser.newContext({ serviceWorkers: "block" });
    const errors = [];
    context.on("page", (page) => page.on("pageerror", (e) => errors.push(e.message)));
    await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await context.addInitScript((port) => {
      window.KN_BROKERS = [{ host: "127.0.0.1", port, path: "/", key: "peerjs" }];
      document.addEventListener("DOMContentLoaded", () => {
        window.KN.net.join = (code, handlers, options) => {
          const net = {
            connectionId: options.connectionId || "kn_abcdefghijklmnopqrstuvwx",
            stopped: false, send() {}, isOpen() { return !this.stopped; },
            stop() { this.stopped = true; }, retryNow() {}
          };
          window.__guestHandlers = handlers;
          setTimeout(() => {
            handlers.state("connected"); handlers.open();
            handlers.message({ type: "WELCOME", clientId: net.connectionId });
          }, 0);
          return net;
        };
      });
    }, local.port);
    const base = "http://127.0.0.1:" + server.address().port + "/";
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(base + "#/r/ABC234");
    await page.fill("#name-gate-input", "Returning Singer");
    await page.click("#name-gate-form button[type=submit]");
    await page.waitForSelector("#view-room:not([hidden])");
    const id = await page.evaluate(() => window.KN.app.net.connectionId);
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("kn:guest")))).connectionId, id);
    await page.reload();
    await page.waitForSelector("#view-room:not([hidden])");
    assert.equal(await page.locator("#name-gate").isVisible(), false);
    assert.equal(await page.evaluate(() => window.KN.app.net.connectionId), id);
    console.log("  ok   guest reload restores the same identity without a name gate");
    await page.goto(base);
    await page.waitForSelector("#view-room:not([hidden])");
    assert.equal(await page.evaluate(() => window.KN.app.role), "guest");
    assert.equal(await page.evaluate(() => window.KN.app.state.code), "ABC234");
    assert.equal(await page.evaluate(() => window.KN.app.net.connectionId), id);
    console.log("  ok   reopening the site root restores the saved guest room");
    await page.evaluate(() => window.__guestHandlers.state("retrying", "timeout"));
    assert.equal(await page.evaluate(() => window.KN.app.role), "guest");
    assert.equal(await page.locator("#view-room").isVisible(), true);
    console.log("  ok   a transport outage keeps the guest in the room");
    await page.evaluate(() => window.__guestHandlers.message({ type: "BYE", reason: "kicked" }));
    await page.waitForSelector("#view-home:not([hidden])");
    assert.equal(await page.evaluate(() => localStorage.getItem("kn:guest")), null);
    await page.reload();
    assert.equal(await page.evaluate(() => window.KN.app.role), null);
    console.log("  ok   an explicit removal clears resume state and is not auto-restored");
    await page.click("#host-btn");
    await page.waitForSelector("#view-room:not([hidden])");
    const code = (await page.textContent("#room-code")).trim();
    await page.goto(base + "#/r/" + code);
    await page.reload();
    await page.waitForSelector("#view-room:not([hidden])");
    assert.equal(await page.evaluate(() => window.KN.app.role), "host");
    assert.equal((await page.textContent("#room-code")).trim(), code);
    console.log("  ok   the owner's invite link restores hosting instead of joining as a guest");
    await page.goto(base);
    await page.waitForSelector("#view-room:not([hidden])");
    assert.equal(await page.evaluate(() => window.KN.app.role), "host");
    assert.equal((await page.textContent("#room-code")).trim(), code);
    console.log("  ok   reopening the site root restores the original host code");
    await page.click("#leave-btn"); await page.click("#leave-room-close");
    await page.waitForSelector("#view-home:not([hidden])");
    await page.reload();
    assert.equal(await page.evaluate(() => window.KN.app.role), null);
    console.log("  ok   closing a room deliberately prevents automatic restoration");
    assert.deepEqual(errors, []);
    await context.close();
    console.log("Session recovery browser checks passed (stand-in guest transport)");

    // Use the real join implementation and native Web Locks here. No host or
    // UDP link is needed to verify exclusive ownership of the saved identity.
    const lockContext = await browser.newContext({ serviceWorkers: "block" });
    await lockContext.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await lockContext.addInitScript((port) => {
      window.KN_BROKERS = [{ host: "127.0.0.1", port, path: "/", key: "peerjs" }];
    }, local.port);
    const first = await lockContext.newPage();
    await first.goto(base);
    assert.equal(await first.evaluate(() => !!navigator.locks), true);
    const firstId = await first.evaluate(() => {
      window.transport = window.KN.net.join("ABC234");
      return window.transport.connectionId;
    });
    await first.waitForFunction(() => navigator.locks.query().then((s) => s.held.length > 0));
    const second = await lockContext.newPage();
    await second.goto(base);
    await second.evaluate((id) => { window.transport = window.KN.net.join("ABC234", {}, { connectionId: id }); }, firstId);
    await second.waitForFunction((id) => window.transport.connectionId !== id, firstId);
    assert.notEqual(await second.evaluate(() => window.transport.connectionId), firstId);
    console.log("  ok   two live tabs receive different transport identities");
    await first.close();
    await second.evaluate((id) => { window.returned = window.KN.net.join("ABC234", {}, { connectionId: id }); }, firstId);
    await second.waitForFunction((id) => navigator.locks.query().then((s) => s.held.some((l) => l.name.endsWith(id))), firstId);
    assert.equal(await second.evaluate(() => window.returned.connectionId), firstId);
    console.log("  ok   closing a tab releases its identity for restoration");
    await lockContext.close();
  } finally {
    if (browser) await browser.close();
    local.peers.forEach((peer) => peer.socket.destroy());
    local.server.close(); server.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
