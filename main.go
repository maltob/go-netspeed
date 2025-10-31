package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/dgraph-io/badger/v4"
	"github.com/google/uuid"
	"github.com/pion/webrtc/v4"
)

// The go:embed directive tells the Go compiler to include all files
// from the 'static' directory into the compiled binary under the variable 'embeddedFiles'.
//
//go:embed static/*
var embeddedFiles embed.FS

// Define configurable settings using command-line flags
var (
	port              = flag.Int("port", 8080, "The port to run the server on.")
	maxDownloadSize   = flag.Int64("maxsize", 100, "Maximum download size in MB (capped at 100MB).")
	downloadChunkSize = flag.Int("chunksize", 1024*1024, "Download chunk size in bytes (default 1MB).")
	webrtcMinPort     = flag.Int("webrtc-min-port", 0, "Minimum UDP port for WebRTC (0 to disable specific range).")
	webrtcMaxPort     = flag.Int("webrtc-max-port", 0, "Maximum UDP port for WebRTC (0 to disable specific range).")

	// Badger Storage Flags
	badgerPath = flag.String("badger-path", "badger_data", "Path for Badger KV store (empty string for in-memory mode).")

	verbose = flag.Bool("verbose", false, "Enable verbose logs for files being served and connections")
)

const (
	globalMaxDownloadSizeMB = 1024
	localOverrideDir        = "static" // Directory to check for local overrides
	embeddedPrefix          = "static" // Prefix under which files are embedded
)

// STUN server configuration for ICE negotiation (required for Pion WebRTC) and global webRTC object
var (
	peerConnectionConfig = webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302"},
			},
		},
	}
	webrtcAPI   *webrtc.API
	globalStore ResultStore
)

// TestResult mirrors the data structure sent by the client after a full test run.
type TestResult struct {
	Timestamp         time.Time `json:"timestamp"`
	DownloadSpeedMbps float64   `json:"downloadSpeedMbps"`
	UploadSpeedMbps   float64   `json:"uploadSpeedMbps"`
	LatencyMs         float64   `json:"latencyMs"`
	JitterMs          float64   `json:"jitterMs"`
	PacketLossPercent float64   `json:"packetLossPercent"`
}

// ResultStore defines the interface for saving and loading test results.
type ResultStore interface {
	Save(result TestResult) (string, error)
	Load(id string) (TestResult, error)
	Close() error
}

// BadgerStore implements ResultStore using the Badger Key-Value database.
type BadgerStore struct {
	db *badger.DB
}

// NewBadgerStore initializes and returns a BadgerStore instance.
func NewBadgerStore(path string) (*BadgerStore, error) {
	opts := badger.DefaultOptions(path)

	// If path is empty, set Badger to run entirely in-memory.
	if path == "" {
		opts = opts.WithInMemory(true)
		log.Println("Badger configured for IN-MEMORY storage (data will be lost on exit).")
	} else {
		// Ensure the directory exists for file storage
		if err := os.MkdirAll(path, 0755); err != nil {
			return nil, fmt.Errorf("failed to create badger directory: %w", err)
		}
		log.Printf("Badger configured for FILE storage at: %s", path)
	}

	db, err := badger.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("failed to open badger db: %w", err)
	}

	return &BadgerStore{db: db}, nil
}

// Save generates a unique ID, saves the result, and returns the ID.
func (s *BadgerStore) Save(result TestResult) (string, error) {
	id := uuid.New().String()

	result.Timestamp = time.Now() // Use server time for official record
	data, err := json.Marshal(result)
	if err != nil {
		return "", err
	}

	err = s.db.Update(func(txn *badger.Txn) error {
		return txn.Set([]byte(id), data)
	})

	if err == nil {
		log.Printf("Result saved with ID: %s", id)
	}
	return id, err
}

// Load retrieves a result by its unique ID.
func (s *BadgerStore) Load(id string) (TestResult, error) {
	var result TestResult
	err := s.db.View(func(txn *badger.Txn) error {
		item, err := txn.Get([]byte(id))
		if err != nil {
			return err // badger.ErrKeyNotFound or other errors
		}

		return item.Value(func(val []byte) error {
			return json.Unmarshal(val, &result)
		})
	})

	if err == badger.ErrKeyNotFound {
		return TestResult{}, fmt.Errorf("result not found for ID: %s", id)
	}
	return result, err
}

// Close ensures the database connection is closed.
func (s *BadgerStore) Close() error {
	return s.db.Close()
}

// --- API Handlers ---
const maxRequestSize = 1024 * 1024

// saveResultHandler receives JSON results from the client, saves them, and returns the unique ID.
func saveResultHandler(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestSize)

	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is supported", http.StatusMethodNotAllowed)
		return
	}

	var result TestResult
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		log.Printf("Failed to decode test result: %v", err)
		http.Error(w, "Invalid JSON result format", http.StatusBadRequest)
		return
	}

	id, err := globalStore.Save(result)
	if err != nil {
		log.Printf("Failed to save result: %v", err)
		http.Error(w, "Failed to save result", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"status": "success", "id": "%s"}`, id)
}

// loadResultHandler retrieves a result by ID from the URL path (/results/{id}).
func loadResultHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Only GET method is supported", http.StatusMethodNotAllowed)
		return
	}

	// Extract the ID from the path (e.g., /results/123-abc)
	id := strings.TrimPrefix(r.URL.Path, "/results/")
	if id == "" {
		http.Error(w, "Missing result ID", http.StatusBadRequest)
		return
	}

	result, err := globalStore.Load(id)
	if err != nil {
		if strings.Contains(err.Error(), "result not found") {
			http.Error(w, "Result not found", http.StatusNotFound)
		} else {
			log.Printf("Error loading result ID %s: %v", id, err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("Failed to encode result: %v", err)
	}
}

// --- Handlers for Network Tests ---

// latencyHandler returns the current time in milliseconds for RTT calculation.
func latencyHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	// We return the server's time for the client to calculate RTT
	fmt.Fprintf(w, "%d", time.Now().UnixMilli())
}

// downloadHandler streams a large amount of random data for speed testing.
func downloadHandler(w http.ResponseWriter, r *http.Request) {
	// 1. Get requested size (in MB)
	sizeParam := r.URL.Query().Get("size")
	requestedSizeMB, err := strconv.ParseInt(sizeParam, 10, 64)
	if err != nil || requestedSizeMB <= 0 {
		requestedSizeMB = 10 // Default to 10MB if not specified or invalid
	}

	// 2. Enforce maximum size cap from flags
	if requestedSizeMB > globalMaxDownloadSizeMB {
		requestedSizeMB = globalMaxDownloadSizeMB
	}
	// Use the configurable flag value
	if requestedSizeMB > *maxDownloadSize {
		requestedSizeMB = *maxDownloadSize
	}

	totalSize := requestedSizeMB * 1024 * 1024

	// Ensure a minimum size for meaningful test
	if totalSize < 1024*1024 {
		totalSize = 1024 * 1024
	}

	// 3. Set response headers
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(totalSize, 10))

	// 4. Stream data in defined chunks
	chunkSize := int64(*downloadChunkSize)
	if chunkSize <= 0 {
		chunkSize = 1024 * 1024 // Fallback 1MB
	}

	// Create a chunk of repeated data to reuse
	chunk := make([]byte, chunkSize)
	for i := range chunk {
		chunk[i] = byte(i % 256)
	}

	var sentBytes int64
	for sentBytes < totalSize {
		bytesToWrite := chunkSize
		if totalSize-sentBytes < chunkSize {
			bytesToWrite = totalSize - sentBytes
		}

		if _, err := w.Write(chunk[:bytesToWrite]); err != nil {
			log.Printf("Download write error: %v", err)
			return
		}
		sentBytes += bytesToWrite

		// Flush the buffer to ensure immediate transmission
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	if *verbose {
		log.Printf("Download stream finished. Total bytes sent: %d", sentBytes)
	}

}

// uploadHandler reads all incoming data and discards it, used for measuring upload speed.
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is supported", http.StatusMethodNotAllowed)
		return
	}

	uploadedBytes, err := io.Copy(io.Discard, r.Body)
	if err != nil {
		log.Printf("Upload failed to read body: %v", err)
		http.Error(w, "Upload failed to read body", http.StatusInternalServerError)
		return
	}
	if *verbose {
		log.Printf("Upload finished. Total bytes received: %d", uploadedBytes)
	}

	w.WriteHeader(http.StatusOK)
}

// ========= WebRTC Handler (Jitter and Packet Loss) =========

type sdp struct {
	SDP string `json:"sdp"`
}

// webrtcOfferHandler handles the SDP Offer/Answer exchange for WebRTC peer connection.
func webrtcOfferHandler(w http.ResponseWriter, r *http.Request) {
	var offer sdp
	if err := json.NewDecoder(r.Body).Decode(&offer); err != nil {
		http.Error(w, "Invalid SDP offer format", http.StatusBadRequest)
		return
	}

	// 1. Create a new PeerConnection
	peerConnection, err := webrtcAPI.NewPeerConnection(peerConnectionConfig)
	if err != nil {
		log.Printf("Failed to create PeerConnection: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Set the remote Session Description (the Offer)
	sdpOffer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offer.SDP,
	}

	if err = peerConnection.SetRemoteDescription(sdpOffer); err != nil {
		log.Printf("Failed to SetRemoteDescription: %v", err)
		http.Error(w, "Invalid SDP", http.StatusBadRequest)
		return
	}

	// 2. Set up the Data Channel Listener
	peerConnection.OnDataChannel(func(dc *webrtc.DataChannel) {
		if *verbose {
			log.Printf("New DataChannel established: %s - %d", dc.Label(), dc.ID())
		}
		dc.OnOpen(func() {
			if *verbose {
				log.Printf("DataChannel '%s' is open. Ready for Jitter/Packet Loss Test.", dc.Label())
			}
		})

		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			// Core logic: echo back the received raw data immediately for RTT/Jitter/Loss calculation.
			if err := dc.Send(msg.Data); err != nil {
				log.Printf("Error echoing data: %v", err)
			}
		})

		dc.OnClose(func() {
			if *verbose {
				log.Printf("DataChannel '%s' closed.", dc.Label())
			}
			peerConnection.Close()
		})
	})

	// 3. Gather ICE candidates and create the SDP Answer
	gatherComplete := webrtc.GatheringCompletePromise(peerConnection)

	// Create the SDP Answer
	answer, err := peerConnection.CreateAnswer(nil)
	if err != nil {
		log.Printf("Failed to create answer: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Set the local Session Description (the Answer)
	if err = peerConnection.SetLocalDescription(answer); err != nil {
		log.Printf("Failed to set local description: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Wait for ICE gathering to complete before sending the Answer
	// This is important for ensuring the remote peer gets all candidates
	<-gatherComplete

	// 4. Send the SDP Answer back to the client
	response := sdp{SDP: peerConnection.LocalDescription().SDP}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Failed to encode response: %v", err)
		return
	}
	if *verbose {
		log.Println("WebRTC SDP Answer sent successfully.")
	}
}

// --- Hybrid Static File Serving (Fixed) ---

// serveHybridFile attempts to serve a file from the local 'static' directory first.
// If the file is not found locally, it falls back to the embedded files.
// It now takes the normalized path directly, which fixes the path doubling bug.
func serveHybridFile(w http.ResponseWriter, r *http.Request, port int, path string) {

	// path is guaranteed to be like "/index.html", "/script.js", etc.
	// 1. Get the file name relative to the current dir (e.g., "index.html")
	fileName := strings.TrimPrefix(path, "/")

	// 2. Check for local override in the current working directory
	localPath := filepath.Join(localOverrideDir, fileName) // e.g., static/index.html

	// Check if the local file exists
	_, err := os.Stat(localPath)
	if err == nil {
		if *verbose {
			log.Printf("Serving local override: %s", localPath)
		}
		http.ServeFile(w, r, localPath)
		return
	}

	// 3. Fallback to embedded file
	embedPath := strings.Join([]string{localOverrideDir, fileName}, "/")
	content, err := fs.ReadFile(embeddedFiles, embedPath)
	if err != nil {
		if os.IsNotExist(err) {
			// If not found in embed.FS either
			http.NotFound(w, r)
		} else {
			log.Printf("Error reading embedded file %s: %v", embedPath, err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		}
		return
	}

	// 4. Set Content-Type based on extension
	contentType := "text/plain"
	switch filepath.Ext(fileName) {
	case ".html":
		contentType = "text/html; charset=utf-8"
	case ".css":
		contentType = "text/css; charset=utf-8"
	case ".js":
		contentType = "application/javascript"
	}

	w.Header().Set("Content-Type", contentType)
	w.Write(content)
}

// logEmbeddedFiles walks the embedded filesystem and logs the paths of all embedded files.
func logEmbeddedFiles() {
	log.Println("Embedded Files:")
	err := fs.WalkDir(embeddedFiles, embeddedPrefix, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// Skip the root directory itself
		if d.IsDir() && path == embeddedPrefix {
			return nil
		}
		// Only log files
		if !d.IsDir() {
			// Print the path relative to the root of embedding for clarity
			relativePath := path //strings.TrimPrefix(path, embeddedPrefix+"/")
			log.Printf("  - %s", relativePath)
		}
		return nil
	})
	if err != nil {
		log.Printf("Error listing embedded files: %v", err)
	}
}

func main() {
	// Parse command-line flags
	flag.Parse()

	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)

	// Validation
	if *maxDownloadSize > globalMaxDownloadSizeMB {
		*maxDownloadSize = globalMaxDownloadSizeMB
		log.Printf("Max download size capped at global maximum: %dMB", globalMaxDownloadSizeMB)
	}

	// 2. Configure WebRTC Ephemeral Port Range
	s := webrtc.SettingEngine{}

	if *webrtcMinPort != 0 && *webrtcMaxPort != 0 && *webrtcMinPort < *webrtcMaxPort {
		// Set the UDP port range for ICE/WebRTC
		s.SetEphemeralUDPPortRange(uint16(*webrtcMinPort), uint16(*webrtcMaxPort))
		log.Printf("WebRTC constrained to UDP port range: %d-%d", *webrtcMinPort, *webrtcMaxPort)
	} else if *webrtcMinPort != 0 || *webrtcMaxPort != 0 {
		log.Printf("Warning: WebRTC port range flags provided but ignored (min=%d, max=%d). Must provide a valid min < max range.", *webrtcMinPort, *webrtcMaxPort)
	}

	// 3. Configure Global Result Store (Badger)
	var err error
	globalStore, err = NewBadgerStore(*badgerPath)
	if err != nil {
		log.Fatalf("Failed to initialize Badger KV store: %v", err)
	}
	// IMPORTANT: Ensure the database is closed when the main function exits
	defer globalStore.Close()

	// Initialize the global API instance with the configured settings
	webrtcAPI = webrtc.NewAPI(webrtc.WithSettingEngine(s))

	// Setup multiplexer and routes
	mux := http.NewServeMux()

	// API routes
	mux.HandleFunc("/latency", latencyHandler)
	mux.HandleFunc("/download", downloadHandler)
	mux.HandleFunc("/upload", uploadHandler)
	mux.HandleFunc("/webrtc/offer", webrtcOfferHandler) // The real WebRTC handler

	// New Storage Routes
	mux.HandleFunc("/save-result", saveResultHandler)
	mux.HandleFunc("/results/", loadResultHandler) // Handles /results/{id}
	// Static file serving (Hybrid: Local/Embedded)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 1. Normalize root path to index.html
		path := r.URL.Path
		if path == "/" {
			path = "/index.html"
		}

		// 2. Pass the normalized path to the server function
		// We no longer prepend the 'static/' path here, fixing the path doubling bug.
		serveHybridFile(w, r, *port, path)
	})

	// Start the server
	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Server starting on %s. Max Download: %dMB, Chunk Size: %d bytes", addr, *maxDownloadSize, *downloadChunkSize)
	log.Printf("Static files are embedded, but can be overridden by placing files in the './static/' directory.")

	// Log the list of embedded files
	if *verbose {
		logEmbeddedFiles()
	}
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}
