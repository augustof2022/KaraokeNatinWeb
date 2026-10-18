"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  let options;
  let instance;
  const calls = { load: 0, play: 0, seek: 0, destroy: 0 };
  function Player(id, opts) {
    assert.equal(id, "host-video");
    options = opts;
    instance = this;
    this.volume = 80;
    this.muted = false;
    setTimeout(() => opts.events.onReady(), 0);
  }
  Player.prototype.getVolume = function () { return this.volume; };
  Player.prototype.setVolume = function (value) { this.volume = value; };
  Player.prototype.isMuted = function () { return this.muted; };
  Player.prototype.mute = function () { this.muted = true; };
  Player.prototype.unMute = function () { this.muted = false; };
  Player.prototype.loadVideoById = function () { calls.load++; };
  Player.prototype.playVideo = function () { calls.play++; };
  Player.prototype.seekTo = function () { calls.seek++; };
  Player.prototype.destroy = function () { calls.destroy++; };

  const page = {
    location: { protocol: "https:", origin: "https://example.com" },
    YT: { Player, PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } }
  };
  const context = vm.createContext({ window: page, console, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/player.js"), "utf8"), context);
  const player = await page.KN.player.create("host-video");
  try {
    assert.equal(options.playerVars.controls, 1, "YouTube's quality controls remain available");
    assert.equal(options.playerVars.fs, 0, "room fullscreen keeps the QR code and overlays");
    assert.equal(options.playerVars.origin, page.location.origin);

    player.volume(150);
    assert.equal(player.volume(), 100);
    player.volume(-5);
    assert.equal(player.volume(), 0);
    instance.volume = 47;
    assert.equal(player.volume(), 47, "native volume changes can be read back");
    player.mute(true);
    assert.equal(player.mute(), true);
    instance.muted = false;
    assert.equal(player.mute(), false, "native mute changes can be read back");

    let buffering = 0;
    player.on("buffering", () => buffering++);
    player.load("aaaaaaaaaaa");
    options.events.onStateChange({ data: 1 });
    for (let i = 0; i < 4; i++) options.events.onStateChange({ data: 3 });
    assert.equal(buffering, 4);
    assert.deepEqual(calls, { load: 1, play: 0, seek: 0, destroy: 0 },
      "buffering notifications must not reload, restart, or seek the video");
  } finally {
    player.destroy();
  }
  assert.equal(calls.destroy, 1);
  console.log("Player quality controls, native sound readback, and non-restarting buffering checks passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
