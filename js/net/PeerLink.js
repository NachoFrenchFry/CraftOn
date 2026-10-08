// PeerLink.js — one WebRTC connection to another player: the RTCPeerConnection, non-trickle offer / answer
// (local description resolved only once ICE gathering completed), two data channels ("reliable": ordered,
// retransmitted — world data, block changes, events; "state": unordered, maxRetransmits 0 — frequent
// snapshots), a ping every PING_SECONDS with a PEER_TIMEOUT_SECONDS timeout, and close detection. It knows
// nothing about how peers were found (LAN lobbies today, online later): `iceServers` is a parameter, [] for
// LAN-only (host / mDNS candidates only).

import { Msg, PING_SECONDS, PEER_TIMEOUT_SECONDS, encode, decode } from './Protocol.js';

const GATHER_TIMEOUT_MS = 3000;
/** Non-trickle ICE: once at least one candidate is in and none arrived for this long, the description is sent as is. */
const GATHER_QUIET_MS = 400;

export class PeerLink {
  /**
   * @param {{ iceServers?: RTCIceServer[], onMessage?: (msg, channel) => void, onOpen?: () => void, onClose?: (reason) => void }} opts
   */
  constructor(opts = {}) {
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers || [] });
    this.onMessage = opts.onMessage || (() => {});
    this.onOpen = opts.onOpen || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.reliable = null;
    this.state = null;
    this.open = false;
    this.closed = false;
    this.rtt = 0;
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
      let quiet = null, candidates = 0, finished = false;
      const done = () => { if (finished) return; finished = true; this.pc.removeEventListener('icegatheringstatechange', check); this.pc.removeEventListener('icecandidate', onCandidate); if (quiet) clearTimeout(quiet); resolve(); };
      const check = () => { if (this.pc.iceGatheringState === 'complete') done(); };
      // Host candidates arrive within milliseconds; the rest of the "complete" wait is mDNS / IPv6 timeouts.
      const onCandidate = (e) => { if (!e.candidate) { done(); return; } candidates++; if (quiet) clearTimeout(quiet); quiet = setTimeout(() => { if (candidates > 0) done(); }, GATHER_QUIET_MS); };
      this.pc.addEventListener('icegatheringstatechange', check);
      this.pc.addEventListener('icecandidate', onCandidate);
      setTimeout(done, GATHER_TIMEOUT_MS);
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
