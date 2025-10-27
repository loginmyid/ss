# Intranet Screen Sharing

screen sharing

```ps
winget install --id FiloSottile.mkcert -e

mkcert -install
mkcert -key-file key.pem -cert-file cert.pem 192.168.123.106 share.local

```

## Embedded TURN (optional)

You can enable a lightweight TURN server inside this Go binary for reliable media on LAN/VLAN that block mDNS/UDP.

Environment variables:

- `TURN_ENABLE=1` to start the TURN server
- `TURN_LISTEN_IP` default `0.0.0.0`
- `TURN_RELAY_IP` default same as `TURN_LISTEN_IP` (use your LAN IP, e.g. `192.168.1.10`)
- `TURN_PUBLIC_HOST` optional hostname/IP advertised to clients (defaults to `TURN_LISTEN_IP`)
- `TURN_PORT` default `3478`
- `TURN_REALM` default `ss.lan`
- `TURN_USER` default `user`
- `TURN_PASS` default `pass`

Example (PowerShell):

```ps1
$env:TURN_ENABLE = "1"
$env:TURN_LISTEN_IP = "0.0.0.0"
$env:TURN_RELAY_IP = "192.168.1.10"  # replace with this machine's LAN IP
$env:TURN_PUBLIC_HOST = "192.168.1.10" # or a DNS name
$env:TURN_USER = "user"
$env:TURN_PASS = "pass"
```

Then run the server and point your clients’ ICE to this TURN:

- Frontend `config.js`: set `ICE_SERVERS` to use `turn:192.168.1.10:3478` with the same `user/pass`.
- Or fetch dynamic ICE from the backend at `GET /ice-config`.

Port/Firewall:

- Allow UDP 3478 to the server
- Allow ephemeral UDP range on the server if needed (TURN will allocate relay ports)
