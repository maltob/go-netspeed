package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/pion/webrtc/v4"
)

// Import the required package for WebRTC

// STUN server configuration for ICE negotiation
var peerConnectionConfig = webrtc.Configuration{
	ICEServers: []webrtc.ICEServer{
		{
			URLs: []string{"stun:stun.l.google.com:19302"},
		},
	},
}
var (
	// -port: The port the HTTP server will listen on. Default: 8080.
	serverPort = flag.Int("port", 8080, "Port for the HTTP server to listen on")
	// -maxsize: Maximum allowed download size in Megabytes (MB). Default: 100.
)

const (
	downloadChunkSize = 4096              // Chunk size to write to the ResponseWriter.
	maxDownloadSize   = 100 * 1024 * 1024 // 100 MB maximum download size
)

// ========= Standard HTTP Handlers (Speed and Latency) =========

// latencyHandler returns the current time in milliseconds for RTT calculation.
func latencyHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "%d", time.Now().UnixMilli())
}

// downloadHandler streams a large buffer to test download speed, respecting a client-requested size.
func downloadHandler(w http.ResponseWriter, r *http.Request) {
	// 1. Parse requested size from query parameters
	sizeParam := r.URL.Query().Get("size")
	requestedSizeMB := int64(50) // Default to 50MB if parameter is missing or invalid

	if sizeParam != "" {
		// Attempt to parse the size, assuming it is an integer in MB
		if val, err := strconv.ParseInt(sizeParam, 10, 64); err == nil {
			requestedSizeMB = val
		}
	}

	// Calculate the total size in bytes, applying the cap
	totalSize := requestedSizeMB * 1024 * 1024
	if totalSize > maxDownloadSize {
		totalSize = maxDownloadSize
		log.Printf("Client requested %dMB, capped download size to %dMB", requestedSizeMB, maxDownloadSize/1024/1024)
	}

	if totalSize < 1024*1024 {
		totalSize = 1024 * 1024 // Minimum 1MB to make the test meaningful
	}

	// 2. Set headers
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", totalSize))

	log.Printf("Starting download stream of %d bytes (%dMB)", totalSize, totalSize/1024/1024)

	// 3. Stream the data
	// Create a buffer of zeros to stream
	data := bytes.Repeat([]byte{0}, downloadChunkSize)

	var totalSent int64
	for totalSent < totalSize {
		toWrite := int64(len(data))
		if totalSent+toWrite > totalSize {
			toWrite = totalSize - totalSent
		}

		n, err := w.Write(data[:toWrite])
		if err != nil {
			// Client might have disconnected, stop streaming
			log.Printf("Download write error: %v", err)
			return
		}
		totalSent += int64(n)

		// Flush the buffer to ensure immediate transmission
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	log.Printf("Download stream finished. Total bytes sent: %d", totalSent)
}

// uploadHandler reads the request body and discards the data to test upload speed.
// It relies on the client (index.html) to define the size.
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	uploadedBytes, err := io.Copy(io.Discard, r.Body)
	if err != nil {
		log.Printf("Upload failed to read body: %v", err)
		http.Error(w, "Upload failed to read body", http.StatusInternalServerError)
		return
	}
	log.Printf("Upload finished. Total bytes received: %d", uploadedBytes)

	// Return success response
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
	peerConnection, err := webrtc.NewPeerConnection(peerConnectionConfig)
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

	// 2. Set up the Data Channel
	peerConnection.OnDataChannel(func(dc *webrtc.DataChannel) {
		log.Printf("New DataChannel established: %s - %d", dc.Label(), dc.ID())

		dc.OnOpen(func() {
			log.Printf("DataChannel '%s' is open. Ready for Jitter/Packet Loss Test.", dc.Label())
		})

		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			// Core logic: echo back the received message immediately.
			// The client sends a binary/text packet, and we echo the raw data back.
			if err := dc.Send(msg.Data); err != nil {
				log.Printf("Error echoing data: %v", err)
			}
		})

		dc.OnClose(func() {
			log.Printf("DataChannel '%s' closed.", dc.Label())
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
	<-gatherComplete

	// 4. Send the SDP Answer back to the client
	response := sdp{SDP: peerConnection.LocalDescription().SDP}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Failed to encode response: %v", err)
		return
	}
}

// startServer sets up and runs the HTTP server.
func startServer() {
	flag.Parse()
	mux := http.NewServeMux()

	// Static file server for the static assets
	mux.Handle("/", http.FileServer(http.Dir("static")))

	// 2. Standard Network Test Endpoints
	mux.HandleFunc("/latency", latencyHandler)
	mux.HandleFunc("/download", downloadHandler)
	mux.HandleFunc("/upload", uploadHandler)

	// 3. WebRTC Signaling Endpoint
	mux.HandleFunc("/webrtc/offer", webrtcOfferHandler)
	portStr := fmt.Sprintf(":%d", *serverPort)
	log.Printf("Starting network test server on %s. Access http://localhost%s", portStr, portStr)
	log.Fatal(http.ListenAndServe(portStr, mux))
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	startServer()
}
