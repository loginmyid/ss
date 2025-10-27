// Frontend configuration for signaling and WebRTC
export const WS_PATH = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

// Adjust ICE servers for your environment.
// For pure LAN tests, an empty list uses only host/mDNS candidates.
// Example TURN config:
// export const ICE_SERVERS = [
//   { urls: [ 'turn:192.168.1.10:3478?transport=udp', 'turn:192.168.1.10:3478?transport=tcp' ], username: 'user', credential: 'pass' },
//   { urls: 'stun:stun.l.google.com:19302' }
// ];
export const ICE_SERVERS = [];

// Toggle to enable periodic getStats logging
export const DEBUG_STATS = true;

