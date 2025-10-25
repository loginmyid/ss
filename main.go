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

type hub struct {
	mu    sync.Mutex
	rooms map[string]map[*client]bool
}

func newHub() *hub {
	return &hub{
		rooms: make(map[string]map[*client]bool),
	}
}

func (h *hub) join(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.rooms[c.room]; !ok {
		h.rooms[c.room] = make(map[*client]bool)
	}
	h.rooms[c.room][c] = true
}

func (h *hub) leave(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.rooms[c.room]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.rooms, c.room)
		}
	}
}

func (h *hub) broadcastToRoom(sender *client, msgType int, data []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.rooms[sender.room] {
		if c != sender {
			_ = c.conn.WriteMessage(msgType, data)
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

		// Client harus kirim pesan JOIN lebih dulu: {type:"join", room:"abc"}
		var cli *client

		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				if cli != nil {
					h.leave(cli)
				}
				return
			}

			// Deteksi join sederhana tanpa JSON unmarshal penuh: cari "join" & "room"
			// (Untuk kesederhanaan; produksi sebaiknya unmarshal JSON.)
			if cli == nil && (string(msg) == "" || string(msg) == "ping") {
				// abaikan ping awal
				continue
			}

			if cli == nil {
				// Minimal parse room dari payload
				// Contoh payload: {"type":"join","room":"ABC"}
				// Di sini demi ringkas kita parsing amat sederhana.
				room := extractField(msg, `"room"`)
				if room == "" {
					// Jika tak ada room, tolak
					_ = conn.WriteMessage(mt, []byte(`{"type":"error","reason":"missing room"}`))
					continue
				}
				cli = &client{conn: conn, room: room}
				h.join(cli)
				_ = conn.WriteMessage(mt, []byte(`{"type":"joined","room":"`+room+`"}`))
				continue
			}

			// Relay semua pesan non-join ke anggota lain di room yang sama
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
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	// WebSocket signaling
	http.HandleFunc("/ws", wsHandler(h))
	port := ":5555"

	log.Fatal(http.ListenAndServeTLS(port, "cert.pem", "key.pem", nil))

	log.Println("Server berjalan di http://localhost" + port)

}
