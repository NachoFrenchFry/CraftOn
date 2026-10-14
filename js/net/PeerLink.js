// PeerLink.js — one WebRTC connection to another player: the RTCPeerConnection, non-trickle offer / answer
// (local description resolved only once ICE gathering completed), two data channels ("reliable": ordered,
// retransmitted — world data, block changes, events; "state": unordered, maxRetransmits 0 — frequent
// snapshots), a ping every PING_SECONDS with a PEER_TIMEOUT_SECONDS timeout, and close detection. It knows
// nothing about how peers were found: `iceServers` is a parameter (STUN + TURN from IceServers.js,
// [] for a LAN-only link with host / mDNS candidates only). `connectionType` says how the selected candidate pair
// travels — "LAN" (both ends private addresses), "Direct" (STUN-punched) or "Relay (TURN)" — from getStats(), refreshed
// with every ping, for F3 and the host's player list.

import { Msg, PING_SECONDS, PEER_TIMEOUT_SECONDS, encode, decode } from './Protocol.js';

/** Non-trickle ICE: the offer / answer carries every candidate gathered within this long (relay allocations take a moment). */
const GATHER_TIMEOUT_MS = 4000;
/**
 * Non-trickle ICE: once no candidate arrived for this long the description is sent as is — but only when the kinds the
 * configuration promises are in: a server-reflexive (srflx) candidate when STUN servers are configured and a relay
 * candidate when TURN servers are, so a slow STUN / TURN answer is not left out of a cross-network offer. A server that
 * reports an error for every one of its URLs (unreachable, bad credentials) drops its requirement; otherwise the wait
 * ends with gathering "complete" or GATHER_TIMEOUT_MS. Same-network play loses nothing: host candidates arrive at once
 * and the quiet timer still ends the wait as soon as the promised kinds are in.
 */
const GATHER_QUIET_MS = 400;

const urlsOf = (servers) => (servers || []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter((u) => typeof u === 'string');
/** Host name of a stun: / turn: URL (lower case), or null. */
const hostOf = (url) => { const m = /^(?:stun|stuns|turn|turns):\[?([^\]:?/]+)/i.exec(String(url || '')); return m ? m[1].toLowerCase() : null; };
/** 'host' | 'srflx' | 'prflx' | 'relay' of an RTCIceCandidate (the `type` property, else parsed from the SDP line). */
function candidateType(c) {
  if (c.type) return c.type;
  const m = /\styp\s+(\w+)/.exec(c.candidate || '');
  return m ? m[1] : 'host';
}

/** Private (RFC 1918 / link-local / ULA) or mDNS addresses mean the same LAN. */
export function isPrivateAddress(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase();
  if (a.endsWith('.local')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || x === 127;
  }
  return a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80') || a === '::1';
}

/**
 * 'Relay (TURN)' when either side is a relay candidate; 'LAN' when both ends talk through host candidates (two
 * interfaces that reach each other directly, so the same network — also with public IPv6 addresses) or both
 * addresses are private / mDNS; else 'Direct' (server-reflexive: punched through NAT).
 */
export function classifyPair(local, remote) {
  if (!local || !remote) return null;
  if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'Relay (TURN)';
  const la = local.address || local.ip, ra = remote.address || remote.ip;
  if (local.candidateType === 'host' && remote.candidateType === 'host') return 'LAN';
  if (la && ra && isPrivateAddress(la) && isPrivateAddress(ra)) return 'LAN';
  return 'Direct';
}

export class PeerLink {
  /**
   * @param {{ iceServers?: RTCIceServer[], onMessage?: (msg, channel) => void, onOpen?: () => void, onClose?: (reason) => void }} opts
   */
  constructor(opts = {}) {
    const iceServers = opts.iceServers || [];
    this.pc = new RTCPeerConnection({ iceServers });
    const urls = urlsOf(iceServers);
    /** The STUN / TURN hosts configured: gathering waits for a srflx / relay candidate while any of them may still answer. */
    this._stunHosts = new Set(urls.filter((u) => /^stuns?:/i.test(u)).map(hostOf).filter(Boolean));
    this._turnHosts = new Set(urls.filter((u) => /^turns?:/i.test(u)).map(hostOf).filter(Boolean));
    this.onMessage = opts.onMessage || (() => {});
    this.onOpen = opts.onOpen || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.reliable = null;
    this.state = null;
    this.open = false;
    this.closed = false;
    this.rtt = 0;
    /** 'LAN' | 'Direct' | 'Relay (TURN)' | null while unknown. */
    this.connectionType = null;
    /** The selected pair as "type address" strings (diagnostics). */
    this.lastPair = null;
    this._statsBusy = false;
    this.lastPong = performance.now();
    this._pingTimer = null;
    this._pingN = 0;
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') this._closed(s);
    };
    this.pc.oniceconnectionstatechange = () => { console.info(`CraftOn net: ice ${this.pc.iceConnectionState}`); if (this.pc.iceConnectionState === 'failed') this._dumpStats(); };
    this.pc.ondatachannel = (e) => this._attach(e.channel);
  }

  /** Host side: create both channels, make the offer and wait for ICE gathering to finish. @returns {Promise<string>} SDP */
  async createOffer() {
    this._attach(this.pc.createDataChannel('reliable', { ordered: true }));
    this._attach(this.pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._gathered();
    return this.pc.localDescription.sdp;
  }

  /** Guest side: accept an offer and answer it (channels arrive through ondatachannel). */
  async createAnswer(offerSdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._gathered();
    return this.pc.localDescription.sdp;
  }

  async acceptAnswer(answerSdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /** Candidate pairs after an ICE failure (diagnostics only). */
  async _dumpStats() {
    try {
      const stats = await this.pc.getStats();
      const byId = new Map(); stats.forEach((r) => byId.set(r.id, r));
      const pairs = [];
      stats.forEach((r) => { if (r.type === 'candidate-pair') { const l = byId.get(r.localCandidateId), m = byId.get(r.remoteCandidateId); pairs.push(`${l ? l.candidateType + ' ' + l.address + ':' + l.port : '?'} -> ${m ? m.candidateType + ' ' + m.address + ':' + m.port : '?'} ${r.state}`); } });
      const local = this.pc.localDescription ? (this.pc.localDescription.sdp.match(/a=candidate/g) || []).length : -1;
      const remote = this.pc.remoteDescription ? (this.pc.remoteDescription.sdp.match(/a=candidate/g) || []).length : -1;
      console.info(`CraftOn net: ice failed; local sdp candidates ${local}, remote ${remote}; pairs: ${pairs.join(' | ') || 'none'}`);
    } catch (e) { /* ignore */ }
  }

  _gathered() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const started = performance.now();
      const counts = { host: 0, srflx: 0, prflx: 0, relay: 0 };
      const stunFailed = new Set(), turnFailed = new Set();
      let quiet = null, candidates = 0, finished = false;
      const needSrflx = () => this._stunHosts.size > 0 && stunFailed.size < this._stunHosts.size && counts.srflx === 0;
      const needRelay = () => this._turnHosts.size > 0 && turnFailed.size < this._turnHosts.size && counts.relay === 0;
      const done = (why) => {
        if (finished) return;
        finished = true;
        this.pc.removeEventListener('icegatheringstatechange', check);
        this.pc.removeEventListener('icecandidate', onCandidate);
        this.pc.removeEventListener('icecandidateerror', onError);
        if (quiet) clearTimeout(quiet);
        console.info(`CraftOn net: ice gathering ${why} after ${Math.round(performance.now() - started)} ms (host ${counts.host}, srflx ${counts.srflx}, relay ${counts.relay}; stun hosts ${this._stunHosts.size} / ${stunFailed.size} failed, turn hosts ${this._turnHosts.size} / ${turnFailed.size} failed)`);
        resolve();
      };
      const check = () => { if (this.pc.iceGatheringState === 'complete') done('complete'); };
      // Host candidates arrive within milliseconds; the quiet timer ends the wait once nothing new came for a while and
      // the kinds the STUN / TURN configuration promises are in (a srflx, a relay); the rest of "complete" is mDNS / IPv6.
      const armQuiet = () => { if (quiet) clearTimeout(quiet); quiet = setTimeout(() => { if (candidates > 0 && !needSrflx() && !needRelay()) done('quiet'); }, GATHER_QUIET_MS); };
      const onCandidate = (e) => {
        if (!e.candidate) { done('complete'); return; }
        candidates++;
        const type = candidateType(e.candidate);
        counts[type] = (counts[type] || 0) + 1;
        armQuiet();
      };
      // A STUN / TURN host that fails (unreachable, DNS, bad credentials) can never deliver its candidate: stop waiting for
      // it. Errors are attributed by host name, not by the URL's scheme: the browser also probes TURN hosts for srflx
      // candidates and reports those failures with a stun: URL, which must not release the real STUN requirement.
      const onError = (e) => {
        const host = hostOf(e.url);
        if (!host) return;
        if (this._stunHosts.has(host)) stunFailed.add(host);
        if (this._turnHosts.has(host)) turnFailed.add(host);
        if (candidates > 0) armQuiet();
      };
      this.pc.addEventListener('icegatheringstatechange', check);
      this.pc.addEventListener('icecandidate', onCandidate);
      this.pc.addEventListener('icecandidateerror', onError);
      setTimeout(() => done('timed out'), GATHER_TIMEOUT_MS);
    });
  }

  _attach(channel) {
    channel.binaryType = 'arraybuffer';
    if (channel.label === 'reliable') this.reliable = channel; else if (channel.label === 'state') this.state = channel; else return;
    channel.onopen = () => this._maybeOpen();
    channel.onclose = () => this._closed('channel closed');
    channel.onerror = () => {};
    channel.onmessage = (e) => {
      const msg = decode(e.data);
      if (!msg) return;
      if (msg.t === Msg.PING) { this.send(Msg.PONG, { n: msg.n }); return; }
      if (msg.t === Msg.PONG) { this.lastPong = performance.now(); this.rtt = performance.now() - (msg.n || this.lastPong); return; }
      this.onMessage(msg, channel.label);
    };
    if (channel.readyState === 'open') this._maybeOpen();
  }

  _maybeOpen() {
    if (this.open || !this.reliable || !this.state) return;
    if (this.reliable.readyState !== 'open' || this.state.readyState !== 'open') return;
    this.open = true;
    this.lastPong = performance.now();
    this._pingTimer = setInterval(() => this._ping(), PING_SECONDS * 1000);
    this.onOpen();
  }

  _ping() {
    if (!this.open) return;
    if (performance.now() - this.lastPong > PEER_TIMEOUT_SECONDS * 1000) { this._closed('timeout'); return; }
    this.send(Msg.PING, { n: performance.now() });
    this.refreshConnectionType();
  }

  /** Classify the selected candidate pair (sets `connectionType`; resolves with it). */
  async refreshConnectionType() {
    if (this._statsBusy || this.closed) return this.connectionType;
    this._statsBusy = true;
    try {
      const stats = await this.pc.getStats();
      const byId = new Map(); stats.forEach((r) => byId.set(r.id, r));
      let pair = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId) || pair; });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = pair || r; });
      if (pair) {
        const l = byId.get(pair.localCandidateId), r = byId.get(pair.remoteCandidateId);
        const type = classifyPair(l, r);
        if (type) { this.connectionType = type; this.lastPair = { local: l && `${l.candidateType} ${l.address || l.ip || '?'}`, remote: r && `${r.candidateType} ${r.address || r.ip || '?'}` }; }
      }
    } catch (e) { /* stats unavailable: keep the last value */ }
    finally { this._statsBusy = false; }
    return this.connectionType;
  }

  /** Send a JSON message on the reliable channel (or `channel = 'state'` for snapshots). Returns false when not open. */
  send(type, fields = {}, channel = 'reliable') {
    const ch = channel === 'state' ? this.state : this.reliable;
    if (!ch || ch.readyState !== 'open') return false;
    try { ch.send(encode({ t: type, ...fields })); return true; } catch (e) { return false; }
  }

  /** Bytes queued on the reliable channel (back-pressure for chunk batches). */
  get bufferedAmount() { return this.reliable ? this.reliable.bufferedAmount : 0; }

  _closed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    console.info(`CraftOn net: peer link closed (${reason}; connection ${this.pc.connectionState}, ice ${this.pc.iceConnectionState}, rtt ${this.rtt.toFixed(0)} ms)`);
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    this.onClose(reason);
  }

  close() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    this.closed = true;
    this.open = false;
    try { this.reliable && this.reliable.close(); } catch (e) { /* ignore */ }
    try { this.state && this.state.close(); } catch (e) { /* ignore */ }
    try { this.pc.close(); } catch (e) { /* ignore */ }
  }
}
