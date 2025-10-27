package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net"
    "net/http"
    "os"
    "strconv"
    "sync"

    "github.com/gorilla/websocket"
    turn "github.com/pion/turn/v2"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Intranet: izinkan semua origin. Ubah sesuai kebutuhan keamanan.
		return true
	},
}

type client struct {
	conn *websocket.Conn
	room string
}

type roomState struct {
	members   map[*client]bool
	presenter *client
}

type hub struct {
	mu    sync.Mutex
	rooms map[string]*roomState
}

func newHub() *hub {
	return &hub{rooms: make(map[string]*roomState)}
}

func (h *hub) join(c *client) {
    h.mu.Lock()
    defer h.mu.Unlock()
    rs, ok := h.rooms[c.room]
    if !ok {
        rs = &roomState{members: make(map[*client]bool)}
        h.rooms[c.room] = rs
    }
    rs.members[c] = true
    log.Printf("[room %s] join: client=%p members=%d presenter=%p", c.room, c, len(rs.members), rs.presenter)
}

func (h *hub) leave(c *client) {
    h.mu.Lock()
    defer h.mu.Unlock()
    if rs, ok := h.rooms[c.room]; ok {
        delete(rs.members, c)
        log.Printf("[room %s] leave: client=%p members=%d presenter=%p", c.room, c, len(rs.members), rs.presenter)
        if rs.presenter == c {
            rs.presenter = nil
            // Beri tahu semua anggota bahwa presenter pergi
            for m := range rs.members {
                _ = m.conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"presenter-left"}`))
            }
            log.Printf("[room %s] presenter cleared due to disconnect", c.room)
        }
        if len(rs.members) == 0 {
            delete(h.rooms, c.room)
            log.Printf("[room %s] room removed (empty)", c.room)
        }
    }
}

func (h *hub) broadcastToRoom(sender *client, msgType int, data []byte) {
    h.mu.Lock()
    rs, ok := h.rooms[sender.room]
    if !ok || rs == nil {
        h.mu.Unlock()
        return
    }
    // salin penerima ke slice agar websocket write di luar lock
    recips := make([]*client, 0, len(rs.members))
    for c := range rs.members {
        if c != sender {
            recips = append(recips, c)
        }
    }
    h.mu.Unlock()

    mt := extractField(data, "\"type\"")
    if mt == "offer" || mt == "answer" {
        log.Printf("[room %s] broadcast %s from %p to %d member(s)", sender.room, mt, sender, len(recips))
    }
    for _, c := range recips {
        if err := c.conn.WriteMessage(msgType, data); err != nil {
            log.Printf("[room %s] write to %p failed: %v", sender.room, c, err)
        }
    }
}

func wsHandler(h *hub) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        conn, err := upgrader.Upgrade(w, r, nil)
        if err != nil {
            log.Println("upgrade:", err)
            return
        }
        defer conn.Close()

		var cli *client

		for {
            mt, msg, err := conn.ReadMessage()
            if err != nil {
                if cli != nil {
                    h.leave(cli)
                }
                log.Printf("ws closed: err=%v", err)
                return
            }
            // Inisialisasi client saat menerima JOIN pertama
            if cli == nil {
                room := extractField(msg, `"room"`)
                if room == "" {
                    _ = conn.WriteMessage(mt, []byte(`{"type":"error","reason":"missing room"}`))
                    log.Printf("[room ?] missing room on first message from conn=%p", conn)
                    continue
                }
                cli = &client{conn: conn, room: room}
                h.join(cli)
                _ = conn.WriteMessage(mt, []byte(`{"type":"joined","room":"`+room+`"}`))
                // Jika sudah ada presenter di room ini, ping presenter agar mengirim offer
                h.mu.Lock()
                var presenter *client
                if rs, ok := h.rooms[room]; ok && rs.presenter != nil && rs.presenter != cli {
                    presenter = rs.presenter
                }
                h.mu.Unlock()
                if presenter != nil {
                    log.Printf("[room %s] join triggers need-offer ping to presenter=%p", room, presenter)
                    _ = presenter.conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"need-offer"}`))
                }
                continue
            }

            // --- Logika presenter & end-presentation ---
            typ := extractField(msg, `"type"`)
            if typ != "" {
                // Lightweight trace for each message
                h.mu.Lock()
                var role string
                if rs, ok := h.rooms[cli.room]; ok && rs.presenter == cli {
                    role = "presenter"
                } else {
                    role = "member"
                }
                h.mu.Unlock()
                log.Printf("[room %s] recv type=%s from %s=%p", cli.room, typ, role, cli)
            }

            if typ == "end-presentation" {
                // Kosongkan presenter untuk room ini, beri tahu members lain
                h.mu.Lock()
                if rs, ok := h.rooms[cli.room]; ok {
                    if rs.presenter == cli {
                        rs.presenter = nil
                        for m := range rs.members {
                            if m != cli {
                                _ = m.conn.WriteMessage(mt, []byte(`{"type":"end-presentation"}`))
                            }
                        }
                        log.Printf("[room %s] end-presentation by presenter=%p", cli.room, cli)
                    }
                }
                h.mu.Unlock()
                continue
            }

            if typ == "need-offer" {
                // Kirim need-offer HANYA ke presenter saat ini
                h.mu.Lock()
                var presenter *client
                if rs, ok := h.rooms[cli.room]; ok && rs.presenter != nil && rs.presenter != cli {
                    presenter = rs.presenter
                }
                h.mu.Unlock()
                if presenter != nil {
                    log.Printf("[room %s] routing need-offer from viewer=%p to presenter=%p", cli.room, cli, presenter)
                    _ = presenter.conn.WriteMessage(mt, msg)
                }
                continue
            }

            if typ == "offer" {
                // Tetapkan presenter jika belum ada; jika sudah ada dan bukan dia, abaikan offer ini
                h.mu.Lock()
                rs, ok := h.rooms[cli.room]
                if ok {
                    if rs.presenter == nil {
                        rs.presenter = cli
                        log.Printf("[room %s] presenter set: %p", cli.room, cli)
                    }
                }
                isPresenter := ok && (rs.presenter == cli)
                h.mu.Unlock()
                if !isPresenter {
                    // TOLAK presenter kedua
                    log.Printf("[room %s] reject offer from non-presenter=%p (presenter exists=%p)", cli.room, cli, rs.presenter)
                    _ = cli.conn.WriteMessage(mt, []byte(`{"type":"error","reason":"presenter-exists"}`))
                    continue
                }
            }

			// Relay (broadcast) ke semua anggota lain di room
			h.broadcastToRoom(cli, mt, msg)
		}
	}
}

// ekstrak nilai string dari JSON sederhana, misalnya "room":"ABC"
// NOTE: demi kesederhanaan, ini bukan parser JSON lengkap.
func extractField(msg []byte, key string) string {
	// cari "key":"VALUE"
	b := msg
	ks := []byte(key)
	i := indexOf(b, ks)
	if i < 0 {
		return ""
	}
	// cari ':' setelah key
	j := indexOf(b[i+len(ks):], []byte(":"))
	if j < 0 {
		return ""
	}
	rest := b[i+len(ks)+j+1:]
	// trim spasi
	for len(rest) > 0 && (rest[0] == ' ' || rest[0] == '\t') {
		rest = rest[1:]
	}
	// harus mulai dengan "
	if len(rest) == 0 || rest[0] != '"' {
		return ""
	}
	rest = rest[1:]
	// ambil sampai quote berikutnya
	val := []byte{}
	for k := 0; k < len(rest); k++ {
		if rest[k] == '"' {
			return string(val)
		}
		val = append(val, rest[k])
	}
	return ""
}

func indexOf(haystack, needle []byte) int {
	n := len(needle)
	if n == 0 {
		return 0
	}
	for i := 0; i+n <= len(haystack); i++ {
		match := true
		for j := 0; j < n; j++ {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func main() {
    h := newHub()

    // Serve static files (frontend) dari ./static
    fs := http.FileServer(http.Dir("."))
    http.Handle("/", fs)

    // WebSocket signaling
    http.HandleFunc("/ws", wsHandler(h))
    // Health and ICE config helpers
    http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200); _, _ = w.Write([]byte("ok")) })
    http.HandleFunc("/ice-config", iceConfigHandler)

    // Optional embedded TURN (enable with TURN_ENABLE=1)
    if os.Getenv("TURN_ENABLE") != "" {
        if err := startTurnServer(context.Background()); err != nil {
            log.Printf("failed starting TURN server: %v", err)
        }
    } else {
        log.Println("TURN server disabled (set TURN_ENABLE=1 to enable)")
    }

    port := ":5555"
    log.Println("Server berjalan di https://localhost" + port)
    log.Fatal(http.ListenAndServeTLS(port, "cert.pem", "key.pem", nil))
}

// --- Optional TURN server (embedded, UDP) ---
func startTurnServer(ctx context.Context) error {
    listenIP := getenv("TURN_LISTEN_IP", "0.0.0.0")
    relayIPStr := getenv("TURN_RELAY_IP", listenIP)
    relayIP := net.ParseIP(relayIPStr)
    if relayIP == nil {
        return fmt.Errorf("invalid TURN_RELAY_IP: %s", relayIPStr)
    }
    port := getenvInt("TURN_PORT", 3478)
    realm := getenv("TURN_REALM", "ss.lan")
    user := getenv("TURN_USER", "user")
    pass := getenv("TURN_PASS", "pass")

    pc, err := net.ListenPacket("udp4", fmt.Sprintf("%s:%d", listenIP, port))
    if err != nil {
        return fmt.Errorf("listen udp %s:%d: %w", listenIP, port, err)
    }

    server, err := turn.NewServer(turn.ServerConfig{
        Realm: realm,
        AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
            // Long-term credential: key = MD5(username:realm:password)
            if username != user {
                return nil, false
            }
            key := turn.GenerateAuthKey(user, realm, pass)
            return key, true
        },
        PacketConnConfigs: []turn.PacketConnConfig{
            {
                PacketConn: pc,
                RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
                    RelayAddress: relayIP,
                    Address:      listenIP,
                },
            },
        },
    })
    if err != nil {
        _ = pc.Close()
        return fmt.Errorf("start TURN: %w", err)
    }

    go func() {
        <-ctx.Done()
        _ = server.Close()
        _ = pc.Close()
    }()

    log.Printf("TURN server listening udp://%s:%d realm=%s relay=%s user=%s",
        listenIP, port, realm, relayIP.String(), user)
    return nil
}

// Expose ICE servers config for frontend convenience
func iceConfigHandler(w http.ResponseWriter, r *http.Request) {
    type iceServer struct {
        URLs       []string `json:"urls"`
        Username   string   `json:"username,omitempty"`
        Credential string   `json:"credential,omitempty"`
    }
    cfg := struct {
        IceServers []iceServer `json:"iceServers"`
    }{}

    if os.Getenv("TURN_ENABLE") != "" {
        host := getenv("TURN_PUBLIC_HOST", getenv("TURN_LISTEN_IP", "127.0.0.1"))
        port := getenvInt("TURN_PORT", 3478)
        user := getenv("TURN_USER", "user")
        pass := getenv("TURN_PASS", "pass")
        cfg.IceServers = append(cfg.IceServers, iceServer{
            URLs:       []string{fmt.Sprintf("turn:%s:%d?transport=udp", host, port), fmt.Sprintf("turn:%s:%d?transport=tcp", host, port)},
            Username:   user,
            Credential: pass,
        })
    }
    // Add STUN for completeness
    cfg.IceServers = append(cfg.IceServers, iceServer{URLs: []string{"stun:stun.l.google.com:19302"}})

    w.Header().Set("Content-Type", "application/json")
    _ = json.NewEncoder(w).Encode(cfg)
}

func getenv(key, def string) string {
    v := os.Getenv(key)
    if v == "" {
        return def
    }
    return v
}

func getenvInt(key string, def int) int {
    v := os.Getenv(key)
    if v == "" {
        return def
    }
    n, err := strconv.Atoi(v)
    if err != nil {
        return def
    }
    return n
}
