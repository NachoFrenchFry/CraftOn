// NetworkId.js — which Wi-Fi am I on? A web page cannot scan the LAN, but every device behind the same router
// shares one public IPv4. A throwaway RTCPeerConnection with a public STUN server reveals it (the srflx
// candidate); the game then publishes / looks for lobbies under network_hash = SHA-256(ip + ':crafton-lan-v1').
// The raw address is never stored or sent — only the hash. With the mock cloud (?mockcloud, headless tests) a
// fixed fake address is used so no STUN request leaves the machine. Main thread only.

const STUN_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
const HASH_SALT = ':crafton-lan-v1';
const DETECT_TIMEOUT_MS = 4000;
const MOCK_IP = '10.0.0.1';

/** SHA-256 hex of the public address plus the salt. */
export async function networkHash(ip) {
  const bytes = new TextEncoder().encode(ip + HASH_SALT);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public IPv4 from a STUN server-reflexive candidate, or null when STUN is blocked / times out. */
export function detectPublicIPv4(servers = STUN_SERVERS, timeoutMs = DETECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let pc;
    let done = false;
    const finish = (ip) => { if (done) return; done = true; try { pc && pc.close(); } catch (e) { /* ignore */ } resolve(ip); };
    try {
      pc = new RTCPeerConnection({ iceServers: servers.map((urls) => ({ urls })) });
    } catch (e) { resolve(null); return; }
    pc.createDataChannel('probe');
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c || !c.candidate) return;
      const m = /typ srflx/.test(c.candidate) ? /(\d{1,3}(?:\.\d{1,3}){3})/.exec(c.address || c.candidate) : null;
      if (m) finish(m[1]);
    };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') finish(null); };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish(null));
    setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * The network hash for lobby discovery: { hash, detected } — `detected` false when the public address could not
 * be found (the UI then says "Couldn't detect your network" and offers Join by code).
 */
export async function detectNetworkHash({ mock = false } = {}) {
  if (mock) return { hash: await networkHash(MOCK_IP), detected: true, mock: true };
  const ip = await detectPublicIPv4();
  if (!ip) return { hash: null, detected: false };
  return { hash: await networkHash(ip), detected: true };
}
