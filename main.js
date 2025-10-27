// ====== Konfigurasi sederhana ======
import { WS_PATH, ICE_SERVERS, DEBUG_STATS } from './config.js';
import { initDebug, logEvent, status, parseCandidate, startStats, stopStats } from './debug.js';
console.log("WS_PATH:", WS_PATH);
const DEBUG_STATS = true; // set false to reduce logs
let statsTimer = null;
let lastBytes = 0;
let lastTs = 0;
const localCandidates = new Set();
const remoteCandidates = new Set();

// ====== Util JSCroot (opsional) ======
const $id = (x) => document.getElementById(x);
const setText = (el, txt) => { el.textContent = txt; };

// ====== UI ======
const roomInput = $id("room");
const btnPresenter = $id("btnPresenter");
const btnViewer = $id("btnViewer");
const statusEl = $id("status");
const videoEl = $id("video");
initDebug({ log: $id('logText'), status: statusEl, video: videoEl });

// ====== State ======
let ws = null;
let pc = null;
let isPresenter = false;
let cachedOffer = null;
// Retry timer for viewer to request a fresh offer
let needOfferTimer = null;


// ====== WebSocket Signaling ======
function connectWS(room) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_PATH);
    sock.onopen = () => {
      logEvent("ws open");
      sock.send(JSON.stringify({ type: "join", room }));
      resolve(sock);
    };
    sock.onclose = (e) => { logEvent(`ws close code=${e.code}`); };
    sock.onerror = (e) => { logEvent("ws error"); reject(e); };
  });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { logEvent(`ws-> ${obj && obj.type}`); } catch {}
    ws.send(JSON.stringify(obj));
  } else {
    logEvent(`ws send failed (state=${ws?ws.readyState:"no ws"}) for ${obj && obj.type}`);
  }
}

// ====== RTCPeerConnection ======
function createPC() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      // Log local candidate type/address
      try {
        const info = parseCandidate(evt.candidate.candidate);
        if (info) {
          const key = `${info.type}|${info.address}|${info.port}`;
          if (!localCandidates.has(key)) {
            localCandidates.add(key);
            logEvent(`local cand: ${info.type} ${info.address}:${info.port}`);
          }
        }
      } catch {}
      wsSend({ type: "ice", candidate: evt.candidate });
    }
  };

  pc.ontrack = (evt) => {
    // viewer menerima track video
    logEvent("ontrack: stream received");
    try {
      videoEl.srcObject = evt.streams[0];
      videoEl.muted = true;
      const playPromise = videoEl.play();
      if (playPromise && typeof playPromise.then === "function") {
        playPromise.catch(() => {});
      }
      status("Stream diterima.");
    } catch (e) {
      logEvent("ontrack error set srcObject");
    }
  };

  pc.onsignalingstatechange = () => {
    logEvent(`pc signalingState=${pc.signalingState}`);
  };
  pc.oniceconnectionstatechange = () => {
    logEvent(`pc iceConnectionState=${pc.iceConnectionState}`);
  };
  pc.onicegatheringstatechange = () => {
    logEvent(`pc iceGatheringState=${pc.iceGatheringState}`);
  };
  pc.onconnectionstatechange = () => {
    logEvent(`pc connectionState=${pc.connectionState}`);
  };

  return pc;
}
let startedViewer = false, startedPresenter = false;
// ==== Helpers (viewer) ====
function startNeedOfferRetry() {
  if (!needOfferTimer) {
    // immediately request once
    wsSend({ type: "need-offer" });
    needOfferTimer = setInterval(() => {
      if (pc && pc.remoteDescription) {
        stopNeedOfferRetry();
      } else {
        wsSend({ type: "need-offer" });
      }
    }, 2000);
  }
}

function stopNeedOfferRetry() {
  if (needOfferTimer) {
    clearInterval(needOfferTimer);
    needOfferTimer = null;
  }
}

function resetViewerPeer() {
  try {
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.close();
      pc = null;
    }
  } catch {}
  try {
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
  } catch {}
}
// ====== Presenter Flow ======
async function startPresenter() {
  if (startedPresenter) return;
  startedPresenter = true;
  const room = (roomInput.value || "").trim();
  if (!room) {
    setText(statusEl, "Isi Room Code dulu.");
    return;
  }

  status("Mempersiapkan...");

  // 1) WebSocket connect & join room
  ws = await connectWS(room);
  ws.onclose = () => status("Koneksi signaling terputus.");
  ws.onerror = () => status("Gagal tersambung ke signaling.");

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data || "{}");
    logEvent(`ws<- presenter ${msg.type}`);
    if (msg.type === "ice" && msg.candidate && msg.candidate.candidate) {
      try {
        const info = parseCandidate(msg.candidate.candidate);
        if (info) {
          const key = `${info.type}|${info.address}|${info.port}`;
          if (!remoteCandidates.has(key)) {
            remoteCandidates.add(key);
            logEvent(`remote cand: ${info.type} ${info.address}:${info.port}`);
          }
        }
      } catch {}
    }
    if (msg.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (msg.type === "ice" && msg.candidate) {
      try { await pc.addIceCandidate(msg.candidate); } catch {}
    } else if (msg.type === "error" && msg.reason === "presenter-exists") {
      // Sudah ada presenter lain di room ini
      status("Presenter lain sedang aktif di room ini.");
      // hentikan lokal agar tidak menggangu
      stopPresenting();
      return;
    } else if (msg.type === "need-offer") {
        if (!pc) return;
        if (pc.localDescription) {
          // Kirim ulang offer yang ada (renegosiasi aman)
          wsSend({ type: "offer", sdp: pc.localDescription });
        } else {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          cachedOffer = offer;
          wsSend({ type: "offer", sdp: offer });
        }
    }
    if (msg.type === "end-presentation" || msg.type === "presenter-left") {
      // Informasi ke semua: viewer tidak perlu melakukan apa-apa di sisi presenter
      setText(statusEl, "Presenter mengakhiri sesi.");
    }
  };

  // 2) Ambil layar (Secure Context: gunakan http://localhost untuk presenter)
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    status("Gagal ambil layar: " + err.message);
    return;
  }
  videoEl.srcObject = stream; // preview lokal (muted)

  // 3) Buat PeerConnection dan addTrack
  createPC();
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  // 4) Buat Offer dan kirim via WS
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  cachedOffer = offer;
  wsSend({ type: "offer", sdp: offer });

  status(`Presenter siap. Room: ${room}. Berikan kode ini ke viewer.`);
  btnEnd.style.display = "inline-block";
}

// ====== Viewer Flow ======
async function startViewer() {
  if(startedViewer) return; startedViewer = true;
  const room = (roomInput.value || "").trim();
  if (!room) {
    status("Isi Room Code dulu.");
    return;
  }

  status("Menghubungkan ke room...");

  ws = await connectWS(room);
  ws.onclose = () => status("Koneksi signaling terputus.");
  ws.onerror = () => status("Gagal tersambung ke signaling.");

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data || "{}");
    logEvent(`ws<- viewer ${msg.type}`);
    if (msg.type === "ice" && msg.candidate && msg.candidate.candidate) {
      try {
        const info = parseCandidate(msg.candidate.candidate);
        if (info) {
          const key = `${info.type}|${info.address}|${info.port}`;
          if (!remoteCandidates.has(key)) {
            remoteCandidates.add(key);
            logEvent(`remote cand: ${info.type} ${info.address}:${info.port}`);
          }
        }
      } catch {}
    }

    if (msg.type === "offer" && msg.sdp) {
        if (!pc) createPC();
        // Selalu set remote dulu (aman utk renegosiasi)
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        
        // === Tambahan: hentikan retry need-offer karena kita sudah dapat offer ===
        stopNeedOfferRetry();
        // Hanya jawab kalau state valid
        if (pc.signalingState === "have-remote-offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          wsSend({ type: "answer", sdp: answer });
        } else {
          // Jika sudah 'stable' atau state lain (mis. duplikat offer), abaikan
          // atau bisa log untuk debug
          console.debug("Skip answer; signalingState=", pc.signalingState);
        }
      //setText(statusEl, `Terhubung ke room: ${room}. Menunggu stream...`);
    } else if (msg.type === "ice" && msg.candidate) {
      try { await pc.addIceCandidate(msg.candidate); } catch {}
    } else if (msg.type === "joined") {
      status(`Terhubung ke room: ${room}. Meminta offer...`);
      if (!pc) createPC();
      startNeedOfferRetry();
      startStats(pc);
    }
    if (msg.type === "end-presentation" || msg.type === "presenter-left") {
      // Reset peer viewer supaya siap menerima presenter berikutnya
      resetViewerPeer();
      status("Presenter mengakhiri sesi. Menunggu presenter baru...");
      // Pastikan kita kembali meminta offer secara berkala
      startNeedOfferRetry();
      stopStats();
    }
  };
}

// ====== Tombol ======

btnPresenter.addEventListener("click", () => {
  isPresenter = true;
  startPresenter();
});

btnViewer.addEventListener("click", () => {
  isPresenter = false;
  startViewer();
});


const btnEnd = $id("btnEnd");

function stopPresenting() {
  try {
    if (videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
    if (pc) {
      pc.getSenders().forEach(s => { try { s.replaceTrack(null); } catch {} });
      pc.close();
      pc = null;
    }
  } catch {}
  status("Presentasi diakhiri.");
  btnEnd.style.display = "none";
  startedPresenter = false; // <— supaya bisa klik “Jadi Presenter” lagi
}

// ====== Stats & Debug Helpers ======
function parseCandidate(line) {
  // RFC5245 candidate line
  if (!line || typeof line !== 'string') return null;
  const parts = line.trim().split(/\s+/);
  const typIndex = parts.indexOf('typ');
  if (parts[0] !== 'candidate' || typIndex === -1) return null;
  return {
    address: parts[4],
    port: parts[5],
    type: parts[typIndex + 1]
  };
}

async function dumpSelectedPair() {
  if (!pc) return;
  try {
    const stats = await pc.getStats();
    let selectedPair, local, remote;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = stats.get(s.selectedCandidatePairId);
        if (pair) selectedPair = pair;
      }
    });
    if (!selectedPair) {
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) {
          selectedPair = s;
        }
      });
    }
    if (selectedPair) {
      local = stats.get(selectedPair.localCandidateId);
      remote = stats.get(selectedPair.remoteCandidateId);
      if (local && remote) {
        const lip = local.ip || local.address;
        const rip = remote.ip || remote.address;
        logEvent(`selected pair: ${local.candidateType}->${remote.candidateType} ${lip}:${local.port} <-> ${rip}:${remote.port}`);
      }
    } else {
      logEvent('selected pair: none');
    }
  } catch {}
}

async function pollStats() {
  if (!pc) return;
  try {
    const stats = await pc.getStats();
    let inbound;
    stats.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
    });
    if (inbound) {
      const ts = inbound.timestamp;
      const bytes = inbound.bytesReceived || 0;
      let bitrateKbps = 0;
      if (lastTs && lastBytes && ts > lastTs && bytes >= lastBytes) {
        const deltaBytes = bytes - lastBytes;
        const deltaMs = ts - lastTs;
        bitrateKbps = ((deltaBytes * 8) / (deltaMs / 1000)) / 1000;
      }
      lastTs = ts; lastBytes = bytes;
      const w = inbound.frameWidth, h = inbound.frameHeight;
      const fps = inbound.framesPerSecond || 0;
      logEvent(`inbound video: ${Math.round(bitrateKbps)} kbps ${w||'?'}x${h||'?'} fps=${fps||'?'} dropped=${inbound.framesDropped||0}`);
    }
    await dumpSelectedPair();
  } catch {}
}

function startStats() {
  if (!DEBUG_STATS) return;
  if (!statsTimer) {
    statsTimer = setInterval(pollStats, 2000);
    logEvent('stats: started');
  }
}
function stopStats() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; logEvent('stats: stopped'); }
}


btnEnd.addEventListener("click", () => {
  wsSend({ type: "end-presentation" });
  stopPresenting();
});
