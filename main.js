// ====== Konfigurasi sederhana ======
const WS_PATH = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
console.log("WS_PATH:", WS_PATH);
// Di intranet biasa, tanpa STUN sudah cukup. Jika perlu, tambahkan server STUN.
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
//const ICE_SERVERS = [];

// ====== Util JSCroot (opsional) ======
const $id = (x) => document.getElementById(x);
const setText = (el, txt) => { el.textContent = txt; };

// ====== UI ======
const roomInput = $id("room");
const btnPresenter = $id("btnPresenter");
const btnViewer = $id("btnViewer");
const statusEl = $id("status");
const videoEl = $id("video");

// ====== State ======
let ws = null;
let pc = null;
let isPresenter = false;
let cachedOffer = null;


// ====== WebSocket Signaling ======
function connectWS(room) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_PATH);
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "join", room }));
      resolve(sock);
    };
    sock.onerror = reject;
  });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ====== RTCPeerConnection ======
function createPC() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      wsSend({ type: "ice", candidate: evt.candidate });
    }
  };

  pc.ontrack = (evt) => {
    // viewer menerima track video
    videoEl.srcObject = evt.streams[0];
  };

  return pc;
}
let startedViewer = false, startedPresenter = false;
// ====== Presenter Flow ======
async function startPresenter() {
  if (startedPresenter) return;
  startedPresenter = true;
  const room = (roomInput.value || "").trim();
  if (!room) {
    setText(statusEl, "Isi Room Code dulu.");
    return;
  }

  setText(statusEl, "Mempersiapkan...");

  // 1) WebSocket connect & join room
  ws = await connectWS(room);
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data || "{}");
    if (msg.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (msg.type === "ice" && msg.candidate) {
      try { await pc.addIceCandidate(msg.candidate); } catch {}
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
  };

  // 2) Ambil layar (Secure Context: gunakan http://localhost untuk presenter)
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    setText(statusEl, "Gagal ambil layar: " + err.message);
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

  setText(statusEl, `Presenter siap. Room: ${room}. Berikan kode ini ke viewer.`);
}

// ====== Viewer Flow ======
async function startViewer() {
  if(startedViewer) return; startedViewer = true;
  const room = (roomInput.value || "").trim();
  if (!room) {
    setText(statusEl, "Isi Room Code dulu.");
    return;
  }

  setText(statusEl, "Menghubungkan ke room...");

  ws = await connectWS(room);

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data || "{}");

    if (msg.type === "offer" && msg.sdp) {
        if (!pc) createPC();
        // Selalu set remote dulu (aman utk renegosiasi)
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
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
      setText(statusEl, `Terhubung ke room: ${room}. Meminta offer...`);
      wsSend({ type: "need-offer" });
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
