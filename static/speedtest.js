/*
 * All JavaScript logic for the Network Test Suite
 */

// Global Constants
const DOWNLOAD_URL = '/download';
const UPLOAD_URL = '/upload';
const LATENCY_URL = '/latency';
const WEBRTC_SIGNALING_URL = '/webrtc/offer';
const MAX_SIZE_MB = 100;
const WEBRTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};
const NUM_PACKETS = 50; // Decreased from 100 to 50
const PACKET_INTERVAL = 50; // Decreased from 100 ms to 50 ms

// History Constants
const HISTORY_KEY = 'networkTestHistory';
const MAX_HISTORY_ITEMS = 5; // Cap the history to the 5 most recent tests

// Global State and Utility
let results = {};
const $ = (id) => document.getElementById(id);

// Utility to update the UI result fields
const updateResult = (id, value, unit = '') => {
    if ($(id)) {
        $(id).textContent = value + unit;
        $(id).classList.remove('text-gray-500', 'text-blue-600');
        $(id).classList.add('text-green-600', 'font-bold');
    }
};

const updateStatus = (id, message, loading = false) => {
    const statusElement = $(id);
    const loaderElement = statusElement.previousElementSibling;
    statusElement.textContent = message;
    statusElement.classList.toggle('text-gray-500', !loading);
    statusElement.classList.toggle('text-blue-600', loading);
    if (loaderElement && loaderElement.classList.contains('loader')) {
        loaderElement.classList.toggle('hidden', !loading);
    }
};

// --- Configuration and Validation ---
function validateSize(input, max) {
    let value = parseInt(input.value);
    if (isNaN(value) || value < 1) {
        input.value = 1;
    } else if (value > max) {
        input.value = max;
    }
}

function getDownloadSizeMB() {
    const input = $('download-size');
    validateSize(input, MAX_SIZE_MB);
    return parseInt(input.value);
}

function getUploadSizeMB() {
    const input = $('upload-size');
    validateSize(input, MAX_SIZE_MB);
    return parseInt(input.value);
}

// --- History Management ---

/**
 * Saves the latest test result to localStorage history.
 * @param {object} result - The current test results object.
 */
function saveHistory(result) {
    // Prepare the item for saving, ensuring consistent structure
    const historyItem = {
        timestamp: new Date().toLocaleString(),
        latency: result.latency ? result.latency.toFixed(2) + ' ms' : 'N/A',
        download: result.download ? result.download.toFixed(2) + ' Mbps' : 'N/A',
        upload: result.upload ? result.upload.toFixed(2) + ' Mbps' : 'N/A',
        jitter: result.jitter ? result.jitter.toFixed(2) + ' ms' : 'N/A',
        packetLoss: result.packetLoss ? result.packetLoss.toFixed(2) + ' %' : 'N/A',
    };

    let history = [];
    try {
        const stored = localStorage.getItem(HISTORY_KEY);
        if (stored) {
            history = JSON.parse(stored);
        }
    } catch (e) {
        console.error("Error loading history from localStorage:", e);
    }

    // Add new item to the front and cap the list size
    history.unshift(historyItem);
    if (history.length > MAX_HISTORY_ITEMS) {
        history = history.slice(0, MAX_HISTORY_ITEMS);
    }

    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        console.error("Error saving history to localStorage:", e);
    }
}

/**
 * Loads history from localStorage and updates the display.
 */
function loadHistory() {
    const historyList = $('history-list'); 
    if (!historyList) {
        // If the element doesn't exist, skip display logic but keep data intact
        return;
    }

    let history = [];
    try {
        const stored = localStorage.getItem(HISTORY_KEY);
        if (stored) {
            history = JSON.parse(stored);
        }
    } catch (e) {
        console.error("Error loading history from localStorage:", e);
        historyList.innerHTML = '<p class="text-red-500">Failed to load history.</p>';
        return;
    }

    historyList.innerHTML = ''; // Clear existing list

    if (history.length === 0) {
        historyList.innerHTML = '<p class="text-gray-500">No test history saved yet.</p>';
        return;
    }

    history.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = `p-3 rounded-lg border-b last:border-b-0 ${index % 2 === 0 ? 'bg-gray-50' : 'bg-white'}`;
        
        row.innerHTML = `
            <div class="font-bold text-sm text-gray-700 mb-1">${item.timestamp}</div>
            <div class="grid grid-cols-2 text-xs gap-x-4 gap-y-1">
                <span class="text-gray-600">Download: <span class="font-semibold text-green-600">${item.download}</span></span>
                <span class="text-gray-600">Upload: <span class="font-semibold text-green-600">${item.upload}</span></span>
                <span class="text-gray-600">Latency: <span class="font-semibold text-blue-600">${item.latency}</span></span>
                <span class="text-gray-600">Jitter: <span class="font-semibold text-red-600">${item.jitter}</span></span>
                <span class="text-gray-600">Loss: <span class="font-semibold text-red-600">${item.packetLoss}</span></span>
            </div>
        `;
        historyList.appendChild(row);
    });
}

/**
 * Finalizes the test run by saving history and re-enabling the button.
 */
function finalizeTest() {
    const startBtn = document.getElementById('start-test-btn');
    // Check if we have at least one meaningful result (e.g., latency) before saving

    if(startBtn.disabled) {
        if (results.latency || results.download || results.upload) {
            saveHistory(results);
        }
        loadHistory();
        
        // Re-enable the button
    
        if (startBtn) {
            startBtn.disabled = false;
        }
    }
}


// --- Test Functions ---

/**
 * LATENCY (RTT) Test
 */
async function runLatencyTest() {
    updateStatus('latency-status', 'Pinging...', true);
    const numPings = 10;
    const latencies = [];
    
    for (let i = 0; i < numPings; i++) {
        const start = performance.now();
        try {
            // Append unique timestamp to prevent caching
            const response = await fetch(LATENCY_URL + '?' + start, { cache: 'no-store' }); 
            if (response.ok) {
                const end = performance.now();
                latencies.push(end - start);
            }
        } catch (e) {
            console.error('Latency test failed:', e);
        }
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
    }

    if (latencies.length === 0) {
        updateStatus('latency-status', 'Failed to measure.', false);
        return;
    }

    const total = latencies.reduce((a, b) => a + b, 0);
    const avgLatency = total / latencies.length;

    results.latency = avgLatency;
    updateResult('latency-result', avgLatency.toFixed(2), ' ms');
    updateStatus('latency-status', 'Complete', false);
}

/**
 * DOWNLOAD Speed Test
 */
async function runDownloadTest() {
    updateStatus('download-status', 'Testing Download...', true);
    const requestedSizeMB = getDownloadSizeMB();
    // Pass size as query param for server to use
    const url = `${DOWNLOAD_URL}?size=${requestedSizeMB}`; 
    
    const start = performance.now();
    try {
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Wait for the entire stream to finish reading
        const reader = response.body.getReader();
        let downloadedBytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            downloadedBytes += value.length;
        }

        const end = performance.now();
        const durationSeconds = (end - start) / 1000;
        const bytes = downloadedBytes; 
        
        if (bytes === 0) {
            updateStatus('download-status', 'Failed: Zero bytes received.', false);
            return;
        }

        // Calculation: (Bytes * 8) / (Seconds * 1024^2) = Mbps
        const speedMbps = (bytes * 8) / (durationSeconds * 1024 * 1024);

        results.download = speedMbps;
        updateResult('download-result', speedMbps.toFixed(2), ' Mbps');
        updateStatus('download-status', 'Complete', false);

    } catch (e) {
        console.error('Download test failed:', e);
        updateStatus('download-status', 'Failed', false);
    }
}

/**
 * UPLOAD Speed Test
 */
async function runUploadTest() {
    updateStatus('upload-status', 'Testing Upload...', true);
    const sizeMB = getUploadSizeMB();
    const sizeBytes = sizeMB * 1024 * 1024;
    
    // Create the blob of the requested size
    const testBlob = new Blob([new ArrayBuffer(sizeBytes)], { type: 'application/octet-stream' });

    const start = performance.now();
    try {
        const response = await fetch(UPLOAD_URL, {
            method: 'POST',
            body: testBlob,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': testBlob.size,
            },
            mode: 'cors' 
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const end = performance.now();
        const durationSeconds = (end - start) / 1000;
        const bytes = testBlob.size;
        
        // Calculation: (Bytes * 8) / (Seconds * 1024^2) = Mbps
        const speedMbps = (bytes * 8) / (durationSeconds * 1024 * 1024);

        results.upload = speedMbps;
        updateResult('upload-result', speedMbps.toFixed(2), ' Mbps');
        updateStatus('upload-status', 'Complete', false);

    } catch (e) {
        console.error('Upload test failed:', e);
        updateStatus('upload-status', 'Failed', false);
    }
}

/**
 * WEBRTC (Jitter & Packet Loss) Test
 */
function runWebRTCTest() {
    updateStatus('jitter-status', 'Starting WebRTC connection...', true);

    const pc = new RTCPeerConnection(WEBRTC_CONFIG);
    let dc = pc.createDataChannel('jitter-test', { negotiated: false, ordered: false, maxRetransmits: 0 });
    
    // Set binaryType to 'arraybuffer' to handle raw byte echo from Go server
    dc.binaryType = 'arraybuffer';
    
    let packetCounter = 0;
    let intervalId = null;

    // 1. Handle ICE Candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            // Candidates are implicitly handled by waiting for gathering to complete
        }
    };

    // 2. Data Channel Setup
    dc.onopen = () => {
        updateStatus('jitter-status', 'Connection established. Sending packets...', true);
        const startTestTime = Date.now();
        const receivedTimestamps = [];
        let receivedCounter = 0;

        // Function to send a packet
        const sendPacket = () => {
            if (packetCounter >= NUM_PACKETS) {
                clearInterval(intervalId);
                return;
            }
            const payload = JSON.stringify({
                id: packetCounter,
                sendTime: Date.now()
            });
            dc.send(payload); 
            packetCounter++;
        };
        
        // Start sending packets
        intervalId = setInterval(sendPacket, PACKET_INTERVAL);
        
        // Handle echo response from Go server
        dc.onmessage = (event) => {
            receivedCounter++;
            try {
                const rawData = event.data;
                let dataString;
                
                // Decode ArrayBuffer to string before JSON parsing
                if (rawData instanceof ArrayBuffer) {
                    dataString = new TextDecoder("utf-8").decode(rawData);
                } else {
                    dataString = rawData;
                }

                const data = JSON.parse(dataString);
                const rtt = Date.now() - data.sendTime;
                
                receivedTimestamps.push(rtt);

                // Check for test completion
                // The new timeout is: (50 * 50) + 2000 = 4500 ms
                if (receivedCounter >= NUM_PACKETS || (packetCounter >= NUM_PACKETS && Date.now() - startTestTime > (NUM_PACKETS * PACKET_INTERVAL + 2000))) {
                    clearInterval(intervalId);
                    dc.close();
                    calculateJitterLoss(receivedTimestamps, packetCounter);
                }

            } catch (e) {
                console.error("Failed to parse data channel message:", e, `Raw Data Type: ${typeof event.data}`, event.data);
            }
        };
    };

    dc.onclose = () => {
        clearInterval(intervalId);
        pc.close();
        if (packetCounter < NUM_PACKETS) {
            updateStatus('jitter-status', 'WebRTC Disconnected before completion.', false);
        }
        // Ensure finalization runs if WebRTC connection closes unexpectedly
        finalizeTest();
    };
    
    pc.oniceconnectionstatechange = () => {
        console.log('ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            clearInterval(intervalId);
            updateStatus('jitter-status', 'WebRTC Failed or Disconnected.', false);
             // Ensure finalization runs if ICE fails
            finalizeTest();
        }
    };
    

    // 3. Create Offer and perform signaling
    pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            // Wait for ICE candidates to settle
            return new Promise(resolve => {
                if (pc.iceGatheringState === 'complete') {
                    resolve();
                } else {
                    pc.onicegatheringstatechange = () => {
                        if (pc.iceGatheringState === 'complete') {
                            resolve();
                        }
                    };
                }
            });
        })
        .then(() => {
            return fetch(WEBRTC_SIGNALING_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sdp: pc.localDescription.sdp })
            });
        })
        .then(response => response.json())
        .then(answer => {
            const sdpAnswer = new RTCSessionDescription({ type: 'answer', sdp: answer.sdp });
            return pc.setRemoteDescription(sdpAnswer);
        })
        .catch(error => {
            console.error('WebRTC Signaling Error:', error);
            updateStatus('jitter-status', 'WebRTC setup failed.', false);
            // Ensure finalization runs if signaling fails
            finalizeTest();
        });
}

function calculateJitterLoss(rtts, totalPacketsSent) {
    const receivedPackets = rtts.length;
    
    // Packet Loss Calculation
    const lossPercent = ((totalPacketsSent - receivedPackets) / totalPacketsSent) * 100;
    
    // Jitter Calculation (Variation in RTTs)
    let sumOfDifferences = 0;
    let previousRTT = rtts.length > 0 ? rtts[0] : 0;
    
    for (let i = 1; i < rtts.length; i++) {
        sumOfDifferences += Math.abs(rtts[i] - previousRTT);
        previousRTT = rtts[i];
    }
    
    const averageJitter = receivedPackets > 1 ? sumOfDifferences / (receivedPackets - 1) : 0;
    
    results.packetLoss = lossPercent;
    results.jitter = averageJitter;

    updateResult('loss-result', lossPercent.toFixed(2), '%');
    updateResult('jitter-result', averageJitter.toFixed(2), ' ms');
    updateStatus('jitter-status', 'Complete', false);

    // Call the single finalization function
    finalizeTest();
}

// --- Master Function and Initialization ---

// Master function to run all tests sequentially
async function runAllTests() {
    // Prevent double execution by disabling the button early
    const startBtn = document.getElementById('start-test-btn');
    if (startBtn) {
        startBtn.disabled = true;
    }
    
    // Reset all results and status
    const resultFields = ['latency-result', 'download-result', 'upload-result', 'loss-result', 'jitter-result'];
    const statusFields = ['latency-status', 'download-status', 'upload-status', 'jitter-status'];

    resultFields.forEach(id => {
        if ($(id)) {
            $(id).textContent = 'N/A';
            $(id).classList.remove('text-green-600', 'font-bold');
            $(id).classList.add('text-gray-500');
        }
    });
    statusFields.forEach(id => updateStatus(id, 'Ready', false));
    
    // Reset global results object for the new test
    results = {};

    // Run sequentially
    await runLatencyTest();
    await runDownloadTest();
    await runUploadTest();
    runWebRTCTest(); // WebRTC is asynchronous and runs independently
}

window.onload = () => {
    // Attach event listeners for size validation on change
    const downloadInput = $('download-size');
    const uploadInput = $('upload-size');
    if (downloadInput) {
        downloadInput.addEventListener('change', () => validateSize(downloadInput, MAX_SIZE_MB));
    }
    if (uploadInput) {
        uploadInput.addEventListener('change', () => validateSize(uploadInput, MAX_SIZE_MB));
    }

    // Attach event listener to the main button
    const startBtn = $('start-test-btn');
    if (startBtn) {
        startBtn.addEventListener('click', runAllTests);
    }

    // Load history on page load
    loadHistory();
};
