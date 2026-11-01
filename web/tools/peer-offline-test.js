/* Exercise the real PeerJS transport with a deterministic fake network. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
let pc;
const sent = [];
class FakeChannel {
  constructor() { this.readyState = "connecting"; }
  send(raw) {
    const message = JSON.parse(raw);
    if (message.t === "__ping") {
      setTimeout(() => this.onmessage({ data: JSON.stringify({ t: "__pong", n: message.n }) }), 0);
    } else sent.push(message);
  }
  close() { this.readyState = "closed"; }
}
class FakePeer {
  constructor() {
    pc = this;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.iceGatheringState = "complete";
    this.signalingState = "stable";
  }
  createDataChannel() { this.channel = new FakeChannel(); return this.channel; }
  createOffer() { return Promise.resolve({ type: "offer", sdp: "fake" }); }
  setLocalDescription(description) {
    this.localDescription = description;
    this.signalingState = "have-local-offer";
    return Promise.resolve();
  }
  setRemoteDescription() {
    this.signalingState = "stable";
    this.connectionState = "connected";
    this.iceConnectionState = "connected";
    setTimeout(() => { this.channel.readyState = "open"; this.channel.onopen(); }, 0);
    return Promise.resolve();
  }
  close() { this.connectionState = "closed"; }
}
class FakeSocket {
  constructor() {
    this.readyState = 0;
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
      if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: "OPEN" }) });
    }, 0);
  }
  send(raw) {
    const msg = JSON.parse(raw);
    if (msg.type === "OFFER") setTimeout(() => {
      if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: "ANSWER", payload: {
        connectionId: msg.payload.connectionId, sdp: { type: "answer", sdp: "fake" }
      } }) });
    }, 0);
  }
  close() { this.readyState = 3; }
}
const document = { hidden: false, addEventListener() {} };
const page = { KN_BROKERS: [{ host: "example.test", port: 80, path: "/", key: "peerjs" }],
  document, addEventListener() {} };
const context = vm.createContext({ window: page, document, console, Promise, Uint8Array, Math, Date,
  setTimeout, clearTimeout, setInterval, clearInterval, WebSocket: FakeSocket,
  RTCPeerConnection: FakePeer, RTCSessionDescription: function (v) { return v; },
  RTCIceCandidate: function (v) { return v; } });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/peer.js"), "utf8"), context);
async function until(fn, message) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out: " + message);
}
(async () => {
  let checking = 0, wakes = 0;
  const link = page.KN.net.join("ABCDEF", { checking: () => checking++, wake: () => wakes++ });
  try {
    assert.equal(link.send({ type: "ADD", video: { id: "offline" } }), false);
    await until(() => link.isOpen(), "initial connection");
    assert.equal(sent.some(m => m.video && m.video.id === "offline"), false, "no offline replay");
    assert.equal(link.send({ type: "PLAY" }), true);
    pc.iceConnectionState = "disconnected";
    pc.oniceconnectionstatechange();
    assert.equal(checking, 1);
    assert.equal(link.isOpen(), false);
    assert.equal(link.send({ type: "SKIP" }), false);
    pc.iceConnectionState = "connected";
    pc.oniceconnectionstatechange();
    await until(() => wakes === 1, "probe after ICE restoration");
    assert.equal(link.isOpen(), true);
    assert.equal(sent.some(m => m.type === "SKIP"), false, "interrupted action was never replayed");
    assert.equal(link.send({ type: "PAUSE" }), true);
    console.log("Peer transport rejects offline/ICE-interrupted commands and verifies restoration");
  } finally { link.stop(); }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
