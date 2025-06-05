package main

import (
	"flag"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Client struct {
	conn *websocket.Conn
	send chan Message
	name string
	done chan struct{} // Channel to signal when the client's goroutines should stop
}

type Message struct {
	Type          string   `json:"type"` // "message", "presence", "video", or "watchHours"
	Sender        string   `json:"sender"`
	Content       string   `json:"content,omitempty"`
	Users         []string `json:"users,omitempty"`
	VideoUrl      string   `json:"videoUrl,omitempty"`
	PlaybackState string   `json:"playbackState,omitempty"`
	CurrentTime   float64  `json:"currentTime,omitempty"`
	Queue         []string `json:"queue,omitempty"`
	Index         int      `json:"index,omitempty"`
	WatchHours    float64  `json:"watchHours,omitempty"`
}

var (
	addr     = flag.String("addr", ":8080", "http service address")
	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			return true // Allowing all origins for development simplicity
		},
	}
	clients    = make(map[*Client]bool)
	clientData = make(map[string]float64) // Map username to authoritative watchHours
	broadcast  = make(chan Message, 256)
	register   = make(chan *Client)
	unregister = make(chan *Client)
	mu         sync.Mutex

	// Shared video state to sync new clients
	sharedVideoState = Message{
		Type:          "video",
		VideoUrl:      "",
		PlaybackState: "pause",
		CurrentTime:   0,
		Queue:         []string{},
		Index:         0,
	}
)

func main() {
	flag.Parse()
	http.HandleFunc("/ws", handleConnections)

	go handleMessages() // Start the central message handling goroutine

	log.Println("Chat server started on", *addr)
	err := http.ListenAndServe(*addr, nil)
	if err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Error upgrading connection: %v", err)
		return
	}

	// Set a short read deadline for the initial username read
	// This prevents a connection from hanging indefinitely if a client connects
	// but doesn't send their username.
	conn.SetReadDeadline(time.Now().Add(12 * time.Second))

	// Read initial message to get username (expected as plain text)
	_, msgBytes, err := conn.ReadMessage()
	if err != nil {
		if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
			log.Printf("Client disconnected before providing username: %v", err)
		} else {
			log.Printf("Error reading initial username message: %v", err)
		}
		conn.Close()
		return
	}
	username := string(msgBytes)
	log.Printf("New client connected: %s", username) // --- DEBUG LOG ---

	client := &Client{
		conn: conn,
		send: make(chan Message, 2048), // Increased buffered channel size for messages
		name: username,
		done: make(chan struct{}), // Channel to signal goroutine termination
	}

	register <- client // Register the client with the handleMessages loop

	go client.writePump() // Start goroutine for writing messages to the client
	client.readPump()     // Start goroutine for reading messages from the client (blocking)
}

func (c *Client) readPump() {
	// Defer unregistering the client and signaling done when this goroutine exits.
	// This ensures cleanup regardless of how readPump terminates (normal close, error).
	defer func() {
		unregister <- c // Signal for unregistration to the handleMessages loop
		close(c.done)   // Signal writePump to stop (if it's still running)
	}()

	c.conn.SetReadLimit(512) // Maximum message size to prevent excessive memory usage
	// Initial read deadline, extended by pong handler.
	// This detects if the client becomes unresponsive.
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second)) // Reset deadline on pong
		return nil
	})

	for {
		var msg Message
		err := c.conn.ReadJSON(&msg) // Attempt to read a JSON message
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[ERROR] ReadPump: Unexpected close error for client %s: %v", c.name, err)
			} else if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				// This handles client-initiated normal closes (e.g., browser tab closed gracefully)
				log.Printf("[INFO] ReadPump: Client %s closed connection normally: %v", c.name, err)
			} else {
				// General read error (e.g., network issue, malformed JSON data, read timeout)
				log.Printf("[WARN] ReadPump: Read error for client %s: %v", c.name, err) // --- DEBUG LOG ---
			}
			break // Exit the read loop on any error, triggering the defer
		}

		msg.Sender = c.name                                                                 // Assign the sender's name from the client's connection
		log.Printf("Server received message from %s: Type=%s, Content='%s', VideoUrl='%s'", // --- DEBUG LOG ---
			msg.Sender, msg.Type, msg.Content, msg.VideoUrl)

		// Update shared video state if the incoming message is a video type
		if msg.Type == "video" {
			mu.Lock()
			// Normalize playbackState: treat "stop" as "pause" for consistency
			if msg.PlaybackState == "stop" {
				msg.PlaybackState = "pause"
			}
			sharedVideoState = msg                                                // Update the global shared video state
			log.Printf("Updated shared video state: URL=%s, State=%s, Time=%.2f", // --- DEBUG LOG ---
				sharedVideoState.VideoUrl, sharedVideoState.PlaybackState, sharedVideoState.CurrentTime)
			mu.Unlock()
		} else if msg.Type == "sync" {
			// Client requests current shared video state
			mu.Lock()
			currentState := sharedVideoState
			mu.Unlock()
			select {
			case c.send <- currentState:
				log.Printf("Sent shared video state to client %s on sync request", c.name)
			default:
				log.Printf("Sync: Client %s send channel full/closed, initiating unregistration", c.name)
				unregister <- c
			}
			continue // Skip broadcasting the sync message
		} else if msg.Type == "watchHours" {
			// Update authoritative watchHours for sender
			mu.Lock()
			clientData[msg.Sender] = msg.WatchHours
			mu.Unlock()
			// Broadcast updated watchHours to all clients
			for client := range clients {
				select {
				case client.send <- msg:
				default:
					log.Printf("WatchHours: Client %s send channel full or closed, skipping watchHours send.", client.name)
				}
			}
			continue // Skip broadcasting original message again
		}

		broadcast <- msg // Send the message to the central broadcast channel
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(54 * time.Second) // Ping interval to keep the connection alive
	defer func() {
		ticker.Stop()
		log.Printf("[INFO] WritePump: Client %s done signal received, exiting gracefully.", c.name)
		unregister <- c // Ensure unregistration is triggered
	}()

	retryWrite := func(writeFunc func() error) error {
		const maxRetries = 3
		for i := 0; i < maxRetries; i++ {
			err := writeFunc()
			if err == nil {
				return nil
			}
			log.Printf("WritePump: Write attempt %d failed for client %s: %v", i+1, c.name, err)
			time.Sleep(100 * time.Millisecond)
		}
		return writeFunc()
	}

	for {
		select {
		case msg, ok := <-c.send: // Receive messages from the client's send channel
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				log.Printf("WritePump: Client %s send channel closed, sending WebSocket close message.", c.name)
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			err := retryWrite(func() error {
				return c.conn.WriteJSON(msg)
			})
			if err != nil {
				log.Printf("WritePump: Write error for client %s after retries: %v", c.name, err)
				return
			}
		case <-ticker.C: // Periodically send a ping message
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			err := retryWrite(func() error {
				return c.conn.WriteMessage(websocket.PingMessage, nil)
			})
			if err != nil {
				log.Printf("WritePump: Ping error for client %s after retries: %v", c.name, err)
				return
			}
		case <-c.done: // Listen for a signal from readPump to stop
			log.Printf("WritePump: Client %s done signal received, exiting gracefully.", c.name)
			return
		}
	}
}

func handleMessages() {
	for {
		select {
		case client := <-register:
			mu.Lock()
			clients[client] = true                                                           // Add the new client to the map of active clients
			log.Printf("Client %s registered. Total clients: %d", client.name, len(clients)) // --- DEBUG LOG ---
			mu.Unlock()

			// --- FIX 1: Send shared video state AFTER client is registered ---
			// This ensures the client is properly initialized in the system before receiving state.
			// Implement retry logic to ensure client receives the initial state.
			go func(c *Client) {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("Recovered from panic in send shared video state goroutine for client %s: %v", c.name, r)
					}
				}()
				for i := 0; i < 3; i++ {
					select {
					case c.send <- sharedVideoState:
						log.Printf("Sent shared video state to new client %s (attempt %d)", c.name, i+1) // --- DEBUG LOG ---
						return
					case <-time.After(500 * time.Millisecond):
						log.Printf("Retry sending shared video state to new client %s (attempt %d)", c.name, i+1) // --- DEBUG LOG ---
					}
				}
				log.Printf("Failed to send shared video state to new client %s after retries. Initiating unregistration.", c.name) // --- DEBUG LOG ---
				unregister <- c
			}(client)
			sendPresence() // Update all clients with the new list of online users

		case client := <-unregister:
			mu.Lock()
			if _, ok := clients[client]; ok { // Check if the client is still in the map
				delete(clients, client)                                                            // Remove client from the active clients map
				close(client.send)                                                                 // Close the client's send channel to stop its writePump
				client.conn.Close()                                                                // Explicitly close the WebSocket connection
				log.Printf("Client %s unregistered. Total clients: %d", client.name, len(clients)) // --- DEBUG LOG ---
			}
			mu.Unlock()
			sendPresence() // Update all clients with the updated list of online users

		case msg := <-broadcast:
			log.Printf("Broadcasting message: Type=%s, Sender=%s, Content='%s'", msg.Type, msg.Sender, msg.Content) // --- DEBUG LOG ---
			mu.Lock()
			for client := range clients {
				select {
				case client.send <- msg:
					// Message sent successfully to this client's send channel
				default:
					log.Printf("Broadcast: Client %s send channel full or closed, unregistering client to prevent blocking.", client.name) // --- DEBUG LOG ---
					delete(clients, client)
					close(client.send)
					client.conn.Close()
				}
			}
			mu.Unlock()
		}
	}
}

func sendPresence() {
	mu.Lock()
	defer mu.Unlock()
	users := []Message{} // Changed to slice of Message to include watchHours
	for client := range clients {
		users = append(users, Message{
			Sender:     client.name,
			WatchHours: 0, // Default 0, will be updated by clients
		})
	}
	presenceMsg := Message{
		Type:  "presence",
		Users: []string{},
	}

	usernames := []string{}
	for _, user := range users {
		usernames = append(usernames, user.Sender)
	}
	presenceMsg.Users = usernames

	log.Printf("Sending presence update: Online users: %v", usernames)

	for client := range clients {
		select {
		case client.send <- presenceMsg:
		default:
			log.Printf("Presence: Client %s send channel full or closed, skipping presence message send to avoid unregistration.", client.name)
		}
	}

	// Broadcast watchHours for each user separately
	for _, user := range users {
		watchHoursMsg := Message{
			Type:       "watchHours",
			Sender:     user.Sender,
			WatchHours: user.WatchHours,
		}
		for client := range clients {
			select {
			case client.send <- watchHoursMsg:
			default:
				log.Printf("WatchHours: Client %s send channel full or closed, skipping watchHours send.", client.name)
			}
		}
	}
}
