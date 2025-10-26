package main

import (
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
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
}

func (h *hub) leave(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rs, ok := h.rooms[c.room]; ok {
		delete(rs.members, c)
		if rs.presenter == c {
			rs.presenter = nil
			// Beri tahu semua anggota bahwa presenter pergi
			for m := range rs.members {
				_ = m.conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"presenter-left"}`))
			}
		}
		if len(rs.members) == 0 {
			delete(h.rooms, c.room)
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

	for _, c := range recips {
		_ = c.conn.WriteMessage(msgType, data)
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
				return
			}
			// Inisialisasi client saat menerima JOIN pertama
			if cli == nil {
				room := extractField(msg, `"room"`)
				if room == "" {
					_ = conn.WriteMessage(mt, []byte(`{"type":"error","reason":"missing room"}`))
					continue
				}
				cli = &client{conn: conn, room: room}
				h.join(cli)
				_ = conn.WriteMessage(mt, []byte(`{"type":"joined","room":"`+room+`"}`))
				continue
			}

			// --- Logika presenter & end-presentation ---
			typ := extractField(msg, `"type"`)

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
					}
				}
				h.mu.Unlock()
				continue
			}

			if typ == "offer" {
				// Tetapkan presenter jika belum ada; jika sudah ada dan bukan dia, abaikan offer ini
				h.mu.Lock()
				rs := h.rooms[cli.room]
				if rs.presenter == nil {
					rs.presenter = cli
				}
				isPresenter := (rs.presenter == cli)
				h.mu.Unlock()
				if !isPresenter {
					// TOLAK presenter kedua
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
	port := ":5555"
	log.Println("Server berjalan di http://localhost" + port)
	log.Fatal(http.ListenAndServeTLS(port, "cert.pem", "key.pem", nil))
}
