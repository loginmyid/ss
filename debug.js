// Debug and status utilities for the WebRTC demo
let logEl = null;
let statusEl = null;
let videoEl = null;

let statsTimer = null;
let lastBytes = 0;
let lastTs = 0;
let currentPc = null;

export function initDebug({ log, status, video }) {
  logEl = log || logEl;
  statusEl = status || statusEl;
  videoEl = video || videoEl;
  if (videoEl) {
    videoEl.addEventListener('playing', () => logEvent('video: playing'));
    videoEl.addEventListener('waiting', () => logEvent('video: waiting'));
    videoEl.addEventListener('stalled', () => logEvent('video: stalled'));
    videoEl.addEventListener('error', () => logEvent('video: error'));
    videoEl.addEventListener('loadedmetadata', () => logEvent(`video: loadedmetadata ${videoEl.videoWidth}x${videoEl.videoHeight}`));
    videoEl.addEventListener('resize', () => logEvent(`video: resize ${videoEl.videoWidth}x${videoEl.videoHeight}`));
  }
}

export function logEvent(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  if (logEl) {
    logEl.textContent += (logEl.textContent.endsWith("\n") ? "" : "\n") + line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }
  try { console.debug(line); } catch {}
}

export function status(msg) {
  if (statusEl) statusEl.textContent = msg;
  logEvent(`status: ${msg}`);
}

// RFC5245 candidate line parser
export function parseCandidate(line) {
  if (!line || typeof line !== 'string') return null;
  const parts = line.trim().split(/\s+/);
  const typIndex = parts.indexOf('typ');
  if (parts[0] !== 'candidate' || typIndex === -1) return null;
  return { address: parts[4], port: parts[5], type: parts[typIndex + 1] };
}

export function startStats(pc) {
  currentPc = pc || currentPc;
  if (!currentPc || statsTimer) return;
  statsTimer = setInterval(pollStats, 2000);
  logEvent('stats: started');
}

export function stopStats() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
    logEvent('stats: stopped');
  }
}

async function dumpSelectedPair(stats) {
  try {
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
  if (!currentPc) return;
  try {
    const stats = await currentPc.getStats();
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
    await dumpSelectedPair(stats);
  } catch {}
}

