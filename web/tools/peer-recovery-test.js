/* Deterministic transport regressions. Real WebRTC tests live in reconnect-e2e.js.
 * A fake clock and protocol endpoints exercise delayed callbacks, redelivery,
 * and lifecycle races without depending on external brokers or UDP access. */
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const source = fs.readFileSync(require.resolve("../js/peer.js"), "utf8");

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function harness() {
  let now = 100000, sequence = 0;
  const timers = new Map(), sockets = [], pcs = [], events = {};
  function schedule(fn, ms, interval) {
    const id = ++sequence;
    timers.set(id, { fn, at: now + ms, interval });
    return id;
  }
  class Socket {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); this.receive({ type: "OPEN" }); }
    receive(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
    send(msg) { this.sent.push(JSON.parse(msg)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }
  class Channel {
    constructor() { this.readyState = "connecting"; this.sent = []; }
    open() { this.readyState = "open"; if (this.onopen) this.onopen(); }
    send(msg) { this.sent.push(JSON.parse(msg)); }
    receive(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
    close() { this.readyState = "closed"; if (this.onclose) this.onclose(); }
  }
  class PC {
    constructor() { this.iceGatheringState = "complete"; this.signalingState = "stable"; this.candidates = []; pcs.push(this); }
    createDataChannel() { return this.dc = new Channel(); }
    incoming() { this.dc = new Channel(); this.ondatachannel({ channel: this.dc }); this.dc.open(); }
    async createOffer() { return { type: "offer", sdp: "offer-" + pcs.indexOf(this) }; }
    async createAnswer() { return { type: "answer", sdp: "answer-" + pcs.indexOf(this) }; }
    async setLocalDescription(sdp) { this.localDescription = sdp; this.signalingState = sdp.type === "offer" ? "have-local-offer" : "stable"; }
    async setRemoteDescription() { this.signalingState = "stable"; }
    async addIceCandidate(c) { this.candidates.push(c); }
    close() { this.closed = true; }
  }
  const document = { hidden: false, addEventListener(name, fn) { (events[name] ||= []).push(fn); } };
  const context = vm.createContext({
    console, crypto: crypto.webcrypto, Uint8Array, Promise, Math,
    Date: { now: () => now }, document,
    KN_BROKERS: [{ host: "local-broker", port: 1234, path: "/", key: "peerjs" }],
    WebSocket: Socket, RTCPeerConnection: PC,
    RTCSessionDescription: function (s) { return s; }, RTCIceCandidate: function (c) { return c; },
    setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: (id) => timers.delete(id),
    addEventListener(name, fn) { (events[name] ||= []).push(fn); }
  });
  vm.runInContext(source, context);
  return {
    net: context.KN.net, pcs, sockets, document,
    event(name) { (events[name] || []).forEach((fn) => fn({})); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.interval) t.at += t.interval; else timers.delete(id);
        t.fn();
        await flush();
      }
      now = end;
      await flush();
    }
  };
}
const offer = (sdp = "first", negotiationId = "attempt-1") => ({
  type: "OFFER", src: "guest-peer", payload: { connectionId: "kn_abcdefghijkl", negotiationId, sdp: { type: "offer", sdp } }
});
async function guestAttempt(h, options) {
  const guest = h.net.join("ABC234", {}, options);
  h.sockets[0].open();
  await flush();
  return guest;
}

test("focus and network events preserve an in-flight handshake", async () => {
  const h = harness();
  const guest = await guestAttempt(h);
  for (let i = 0; i < 10; i++) { h.event("online"); h.event("visibilitychange"); h.event("focus"); }
  await flush();
  assert.equal(h.pcs.length, 1);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.pcs[0].closed, undefined);
  guest.stop();
});

test("wake events also preserve the initial broker WebSocket handshake", async () => {
  const h = harness();
  const guest = h.net.join("ABC234");
  for (let i = 0; i < 10; i++) { h.event("online"); h.event("visibilitychange"); }
  assert.equal(h.sockets.length, 1);
  h.sockets[0].open(); await flush();
  assert.equal(h.pcs.length, 1);
  guest.stop();
});

test("a delayed answer callback cannot time out an already open channel", async () => {
  const h = harness();
  const guest = await guestAttempt(h);
  const pc = h.pcs[0];
  let finish;
  pc.setRemoteDescription = () => new Promise((resolve) => { finish = resolve; });
  const sent = h.sockets[0].sent.find((m) => m.type === "OFFER");
  h.sockets[0].receive({ type: "ANSWER", payload: { ...sent.payload, sdp: { type: "answer", sdp: "ok" } } });
  pc.dc.open();
  finish();
  await flush();
  await h.advance(15000);
  assert.equal(guest.state, "connected");
  assert.equal(pc.closed, undefined);
  guest.stop();
});

test("duplicate offers reuse a pending or connected host link and its answer", async () => {
  const h = harness();
  const host = h.net.host("ABC234");
  const socket = h.sockets[0]; socket.open();
  socket.receive(offer()); socket.receive(offer());
  await flush();
  assert.equal(h.pcs.length, 1);
  h.pcs[0].incoming();
  socket.receive(offer());
  await flush();
  assert.equal(host.guests().length, 1);
  assert.equal(h.pcs.length, 1);
  assert.equal(socket.sent.filter((m) => m.type === "ANSWER").length, 2);
  host.stop();
});

test("host wake does not destroy a guest that is still negotiating", async () => {
  const h = harness();
  const host = h.net.host("ABC234");
  h.sockets[0].open(); h.sockets[0].receive(offer());
  await flush();
  host.wake(); await flush();
  assert.equal(h.pcs[0].closed, undefined);
  h.pcs[0].incoming();
  assert.equal(host.guests().length, 1);
  host.stop();
});

test("superseded negotiations cannot send stale answers or ICE into the new link", async () => {
  const h = harness();
  const host = h.net.host("ABC234");
  const s = h.sockets[0]; s.open();
  s.receive(offer()); s.receive(offer("second", "attempt-2"));
  await flush();
  const answers = s.sent.filter((m) => m.type === "ANSWER");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].payload.negotiationId, "attempt-2");
  s.receive({ type: "CANDIDATE", src: "guest-peer", payload: { connectionId: "kn_abcdefghijkl", negotiationId: "attempt-1", candidate: { candidate: "old" } } });
  s.receive({ type: "CANDIDATE", src: "guest-peer", payload: { connectionId: "kn_abcdefghijkl", negotiationId: "attempt-2", candidate: { candidate: "new" } } });
  assert.equal(h.pcs[1].candidates.length, 1);
  assert.equal(h.pcs[1].candidates[0].candidate, "new");
  host.stop();
});

test("repeated broker conflicts never rename a host room", async () => {
  const h = harness();
  let surrendered = false;
  const host = h.net.host("ABC234", { token: "saved-token", on: { "code-taken": () => { surrendered = true; } } });
  for (let i = 0; i < 6; i++) {
    h.sockets.at(-1).receive({ type: "ID-TAKEN" });
    await h.advance(6500);
  }
  assert.equal(surrendered, false);
  assert.equal(host.code, "ABC234");
  assert.equal(host.token, "saved-token");
  host.stop();
});

test("a slow wake-up pong does not discard a working channel", async () => {
  const h = harness();
  const guest = await guestAttempt(h);
  const pc = h.pcs[0]; pc.dc.open();
  h.event("online"); h.event("visibilitychange");
  await h.advance(4000);
  const probe = pc.dc.sent.find((m) => typeof m.n === "string");
  assert.ok(probe);
  assert.equal(pc.dc.sent.filter((m) => typeof m.n === "string").length, 1, "wake events share a probe");
  pc.dc.receive({ t: "__pong", n: probe.n });
  await h.advance(12000);
  assert.equal(guest.state, "connected");
  assert.equal(h.pcs.length, 1);
  guest.stop();
});

test("missing pongs get a grace period but a dead foreground link eventually retries", async () => {
  const h = harness();
  const guest = await guestAttempt(h);
  h.pcs[0].dc.open();
  h.event("online");
  await h.advance(15000);
  assert.equal(guest.state, "connected");
  await h.advance(65000);
  assert.equal(h.pcs[0].closed, true);
  assert.notEqual(guest.state, "connected");
  guest.stop();
});

test("a saved opaque guest identity survives reload and remains bannable", async () => {
  const h = harness();
  const original = h.net.join("ABC234");
  const id = original.connectionId; original.stop();
  assert.match(id, /^kn_[a-z0-9]{24}$/);
  const returned = h.net.join("ABC234", {}, { connectionId: id });
  assert.equal(returned.connectionId, id);
  returned.stop();
  const host = h.net.host("ABC234");
  const s = h.sockets.at(-1); s.open();
  const m = offer(); m.payload.connectionId = id;
  s.receive(m); await flush(); h.pcs.at(-1).incoming();
  host.kick(id);
  const count = h.pcs.length;
  s.receive(m); await flush();
  assert.equal(h.pcs.length, count);
  assert.equal(host.guests().length, 0);
  host.stop();
});
