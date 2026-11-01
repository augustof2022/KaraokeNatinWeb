/* The host video must have usable dimensions and unobstructed controls in both
 * modern browsers and Android browsers without CSS aspect-ratio or 100dvh. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const NET = `KN.net.host = function () { return { token:'test', onlineBrokers:function(){return 1;}, guests:function(){return [];}, stop:function(){}, broadcast:function(){} }; };`;
const PLAYER = `KN.player.create = function (id) {
  var frame = document.createElement('iframe');
  frame.id = id;
  frame.srcdoc = '<style>html,body{height:100%;margin:0;background:#218a51;color:white}</style><button>Video control</button>';
  document.getElementById(id).replaceWith(frame);
  window.__videoFrame = frame;
  window.__playerCalls = { load:0, play:0, pause:0, stop:0, seek:0, destroy:0 };
  var events = {}, volume = 80;
  function emit(name) { (events[name] || []).forEach(function (f) { f(); }); }
  var player = {
    on:function(name, fn){ (events[name] = events[name] || []).push(fn); return player; },
    load:function(){window.__playerCalls.load++; setTimeout(function(){emit('playing');}, 0);},
    play:function(){window.__playerCalls.play++; emit('playing');},
    pause:function(){window.__playerCalls.pause++; emit('paused');},
    stop:function(){window.__playerCalls.stop++;}, seek:function(){window.__playerCalls.seek++;},
    destroy:function(){window.__playerCalls.destroy++;},
    time:function(){return 30;}, duration:function(){return 240;}, meta:function(){return {duration:240};},
    volume:function(v){if(arguments.length) volume=v; return volume;}, mute:function(){return false;}
  };
  return Promise.resolve(player);
};`;

async function main() {
  const site = http.createServer((req, res) => {
    const rel = req.url.split("?")[0].replace(/^\/+/, "") || "index.html";
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.setHeader("content-type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    for (const legacy of [true, false]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
      await context.addInitScript(() => {
        localStorage.setItem("kn:host", JSON.stringify({
          at:Date.now(), code:"ABC234", token:"test", queue:[],
          now:{ sid:"one", id:"aaaaaaaaaaa", title:"Test song", duration:240 },
          config:{ sounds:false, scoring:false }
        }));
      });
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === "/css/app.css" && legacy) {
          const css = fs.readFileSync(path.join(ROOT, "css/app.css"), "utf8")
            .replace(/aspect-ratio\s*:[^;]+;/g, "")
            .replace(/height\s*:\s*100dvh\s*;/g, "")
            .replace(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s*clamp\([^;]+;/g, "")
            .replace(/inset\s*:\s*0\s*;/g, "");
          return route.fulfill({ contentType:"text/css", body:css });
        }
        const stub = url.pathname === "/js/peer.js" ? NET : url.pathname === "/js/player.js" ? PLAYER : null;
        if (stub) return route.fulfill({ contentType:"application/javascript", body:fs.readFileSync(path.join(ROOT, url.pathname), "utf8") + "\n" + stub });
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.goto(origin + "/#/host");
      await page.waitForFunction(() => window.KN.app.player && window.KN.app.state.player.status === "playing");
      const before = await page.evaluate(() => JSON.stringify(window.__playerCalls));
      for (const size of [{width:1280,height:720}, {width:1024,height:600}, {width:390,height:844}, {width:800,height:450}]) {
        await page.setViewportSize(size);
        const frame = await page.locator("#yt-frame").boundingBox();
        const stage = await page.locator("#stage").boundingBox();
        const controls = await page.locator("#stage-controls").boundingBox();
        const label = `${legacy ? "legacy CSS" : "modern CSS"} ${size.width}x${size.height}`;
        assert.ok(frame && frame.width >= 300 && frame.height >= 180, `${label}: video is too small: ${JSON.stringify(frame)}`);
        assert.ok(frame.width >= stage.width * 0.9, `${label}: frame does not fill the stage`);
        assert.ok(controls && controls.y >= frame.y + frame.height - 1, `${label}: controls overlap the video`);
        assert.equal(await page.frameLocator("#yt-frame").getByRole("button", {name:"Video control"}).isVisible(), true, `${label}: frame content is not visible`);
        if (process.env.KN_SCREENSHOT_DIR && size.width === 1280) {
          await page.screenshot({ path:path.join(process.env.KN_SCREENSHOT_DIR, legacy ? "windowed-legacy.png" : "windowed-modern.png") });
        }
      }
      await page.setViewportSize({width:1280,height:720});
      await page.locator("#fs-btn").click();
      await page.waitForFunction(() => document.fullscreenElement === document.getElementById("stage"));
      await page.waitForSelector("#stage #stage-controls");
      assert.equal(await page.locator("#stage #stage-controls").count(), 1, "controls stay usable in fullscreen");
      await page.frameLocator("#yt-frame").getByRole("button", {name:"Video control"}).click();
      await page.locator("#fs-btn").click();
      await page.waitForFunction(() => !document.fullscreenElement);
      await page.waitForSelector("#stage-controls-home #stage-controls");
      assert.equal(await page.locator("#stage-controls-home #stage-controls").count(), 1, "controls return below the video");
      assert.equal(await page.evaluate(() => document.getElementById("yt-frame") === window.__videoFrame), true, "resizing keeps the player iframe");
      assert.equal(await page.evaluate(() => JSON.stringify(window.__playerCalls)), before, "resizing and fullscreen do not interrupt playback");
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`  ok   ${legacy ? "older" : "modern"} browser layout keeps the video visible and controls below it`);
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => site.close(resolve));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
