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
const NUM_PACKETS = 250; 
const PACKET_INTERVAL = 40; // ms
const MAX_WAIT_BUFFER = 1000; //ms

// History Constants
const HISTORY_KEY = 'networkTestHistory';
const MAX_HISTORY_ITEMS = 5; // Cap the history to the 5 most recent tests

// Global State and Utility
let results = {};
const $ = (id) => document.getElementById(id);


function displaySharedResult(data) {
    updateSharedResult('download-result', data.downloadSpeedMbps.toFixed(2)+' Mbps');
    updateSharedResult('upload-result', data.uploadSpeedMbps.toFixed(2)+' Mbps');
    updateSharedResult('latency-result', data.latencyMs+' ms');
    updateSharedResult('jitter-result', data.jitterMs.toFixed(2)+' ms');
    updateSharedResult('loss-result', data.packetLossPercent.toFixed(2)+'%');

    //Hide the "Ready" text
    document.getElementById("download-status").style.visibility="hidden"
    document.getElementById("upload-status").style.visibility="hidden"
    document.getElementById("jitter-status").style.visibility="hidden"
    document.getElementById("latency-status").style.visibility="hidden"


    document.getElementById('share-url').innerHTML = `
        <div class="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm">
            <span class="text-green-700 font-medium">Viewing Shared Result (ID: ${new URLSearchParams(window.location.search).get('resultId')}).</span>
        </div>
    `;
}

function loadResultFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const resultId = params.get('resultId');

    if (resultId) {
        //updateStatus(`Loading result ID: ${resultId}...`, 'text-indigo-500');
        
        // Prevent running new tests while viewing a shared result
        document.getElementById('start-test-btn').disabled = true;
document.getElementById('result-history-div').hidden = true;
document.getElementById('config-controls').hidden = true;
        fetch(`/results/${resultId}`)
            .then(response => {
                if (!response.ok) throw new Error('Result not found or server error.');
                return response.json();
            })
            .then(data => {
                displaySharedResult(data);
            })
            .catch(error => {
                console.error("Error loading shared result:", error);
               
            });
    }
}


function updateSharedResult(testName, value, color = 'text-gray-900') {
    const element = document.getElementById(testName);
    if (element) {
        element.innerText = value;
        element.className = element.className.replace(/text-(green|red|blue|gray)-\d{3}/, color);
    }
}

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
    statusElement.textContent = message;
    statusElement.classList.toggle('text-gray-500', !loading);
    statusElement.classList.toggle('text-blue-600', loading);

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
        latency: result.latencyMs ? result.latencyMs.toFixed(2) + ' ms' : 'N/A',
        download: result.downloadSpeedMbps ? result.downloadSpeedMbps.toFixed(2) + ' Mbps' : 'N/A',
        upload: result.uploadSpeedMbps ? result.uploadSpeedMbps.toFixed(2) + ' Mbps' : 'N/A',
        jitter: result.jitterMs ? result.jitterMs.toFixed(2) + ' ms' : 'N/A',
        packetLoss: result.packetLossPercent ? result.packetLossPercent.toFixed(2) + ' %' : 'N/A',
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
function finalizeTest(success = true) {
    const startButton = document.getElementById('start-test-btn');
    const shareUrlElement = document.getElementById('share-url');
    shareUrlElement.innerHTML = ''; // Clear previous share link

    if (!success) {
        // If an early failure occurred (e.g., download failed), update results and enable button.
        updateResult('download', 'N/A', 'text-gray-500');
        updateResult('upload', 'N/A', 'text-gray-500');
        updateResult('latency', 'N/A', 'text-gray-500');
        updateResult('jitter', 'N/A', 'text-gray-500');
        updateResult('packet-loss', 'N/A', 'text-gray-500');
        startButton.disabled = false;
        return;
    }

    const finalResults = {
        downloadSpeedMbps: parseFloat(document.getElementById('download-result').innerText) || 0,
        uploadSpeedMbps: parseFloat(document.getElementById('upload-result').innerText) || 0,
        latencyMs: parseFloat(document.getElementById('latency-result').innerText) || 0,
        jitterMs: parseFloat(document.getElementById('jitter-result').innerText) || 0,
        packetLossPercent: parseFloat(document.getElementById('loss-result').innerText) || 0,
    };

    // 1. Send results to the server to be saved and get a unique ID
    fetch(`/save-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalResults)
    })
    .then(response => {
        if (!response.ok) throw new Error('Failed to save result on server.');
        return response.json();
    })
    .then(data => {
        const resultId = data.id;
        if (resultId) {
            // Construct the shareable URL
            const currentHostname = window.location.hostname;
            const portSegment = window.location.port ? `:${window.location.port}` : '';
            const shareUrl = `${window.location.protocol}//${currentHostname}${portSegment}/?resultId=${resultId}`;
            
            // Display the shareable link
            shareUrlElement.innerHTML = `
                <div class="mt-4 p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-sm flex items-center justify-between">
                    <span class="text-indigo-700 font-medium mr-4">Share URL:</span>
                    <a id="share-link" href="${shareUrl}" class="truncate text-indigo-600 hover:text-indigo-800 underline flex-grow" target="_blank">${shareUrl}</a>
                    <button onclick="copyToClipboard('${shareUrl}')" class="ml-4 p-1 rounded-full text-indigo-600 hover:bg-indigo-200 transition duration-150">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-2m-4-4l-4 4m0 0l-4-4m4 4V5"></path></svg>
                    </button>
                </div>
            `;
        }
    })
    .catch(error => {
        console.error("Error saving or fetching share ID:", error);
        shareUrlElement.innerHTML = `<p class="text-red-500 mt-4">Failed to save results for sharing.</p>`;
    })
    .finally(() => {
        // Save history (local storage) and re-enable button regardless of server save success
        if(startButton.disabled) {
            if (results.latency || results.download || results.upload) {
            saveHistory(finalResults);
            startButton.disabled = false;
            startButton.classList.remove('bg-gray-400', 'cursor-not-allowed');
            }
        }
    });
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
                console.log("All packets sent");
                //Wait a max period of time for all packets to be received
                 setTimeout(function(){
                                clearInterval(intervalId);
                                dc.close();
                                console.log("Calculating jitter - timeout reached");
                                calculateJitterLoss(receivedTimestamps, packetCounter);
                    },(Date.now() -(startTestTime + NUM_PACKETS * PACKET_INTERVAL + MAX_WAIT_BUFFER)))
                return;
            }
            const payload = JSON.stringify({
                id: packetCounter,
                sendTime: Date.now()
            });
            dc.send(payload); 
            packetCounter++;
            updateStatus('jitter-status', 'Connection established. Sending packets...'+packetCounter+'/'+NUM_PACKETS, true);
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
                // The new timeout is: (250 * 40) + 1000 = 11000 ms
                if ((receivedCounter >= NUM_PACKETS) || (packetCounter >= NUM_PACKETS && Date.now() - startTestTime > (NUM_PACKETS * PACKET_INTERVAL + MAX_WAIT_BUFFER))) {
                    clearInterval(intervalId);
                    dc.close();
                    console.log("Calculating jitter");
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

    // Check if we are loading a shared result URL
    loadResultFromUrl();
};
