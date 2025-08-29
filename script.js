// --- DOM Elements ---
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const loginBtn = document.getElementById('loginBtn');
const userIdInput = document.getElementById('userId');
const userList = document.getElementById('userList');
const commsLog = document.getElementById('comms-log');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const chattingWith = document.getElementById('chatting-with');

// --- App State ---
let localStream;
let myUserId;
let currentChatPartner;
const peerConnections = {}; // { userId: RTCPeerConnection }
const chatHistories = {}; // { userId: [{ sender, message }] }

// --- Configuration ---
const servers = {
    iceServers: [
        {
            urls: 'stun:stun.l.google.com:19302' // Google's public STUN server
        },
        // In a real-world application, you would also have TURN servers here.
        // TURN servers are needed to relay traffic when a direct P2P connection fails.
        // {
        //   urls: 'turn:your.turn.server.com',
        //   username: 'user',
        //   credential: 'password'
        // }
    ]
};

// --- Socket.IO Connection ---
// The server URL should be configurable, but for now, we'll hardcode it.
const socket = io('http://localhost:3000');

// --- Utility Functions ---

/**
 * Logs messages to the on-screen communication log for debugging.
 * @param {string} direction - 'SENT' or 'RECEIVED'.
 * @param {string} event - The name of the socket event.
 * @param {object} [data] - The data payload of the event.
 */
function logToViewport(direction, event, data) {
    const logMessage = `[${direction}] ${event}: ${JSON.stringify(data || {})}\n`;
    commsLog.textContent += logMessage;
    commsLog.scrollTop = commsLog.scrollHeight; // Auto-scroll to bottom
}

// --- Initialization ---

// Get user's camera and microphone
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
        localVideo.srcObject = stream;
        localStream = stream;
    })
    .catch(error => console.error('Error accessing media devices.', error));

// --- Event Listeners ---

// Login button
loginBtn.addEventListener('click', () => {
    const userId = userIdInput.value.trim();
    if (userId) {
        myUserId = userId;
        socket.emit('login', myUserId);
        logToViewport('SENT', 'login', { userId: myUserId });

        document.getElementById('login-container').style.display = 'none';
        document.getElementById('main-container').style.display = 'flex';
    } else {
        alert('Please enter a name to log in.');
    }
});

// Send chat message button
sendChatBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') {
        sendChatMessage();
    }
});

// --- Socket.IO Event Handlers ---

socket.on('connect', () => {
    logToViewport('INFO', 'connect', { socketId: socket.id });
});

// Update the list of online users
socket.on('user-list', (users) => {
    logToViewport('RECEIVED', 'user-list', users);
    userList.innerHTML = '';
    users.forEach(user => {
        if (user !== myUserId) {
            const li = document.createElement('li');
            li.textContent = user;
            li.dataset.userId = user;
            li.addEventListener('click', () => selectUserToChat(user));
            userList.appendChild(li);
        }
    });
    // If the current chat partner went offline, clean up
    if (currentChatPartner && !users.includes(currentChatPartner)) {
        cleanUpForUser(currentChatPartner);
    }
});

// Handle incoming call offer
socket.on('offer', async (data) => {
    logToViewport('RECEIVED', 'offer', data);
    const { fromUserId, offer } = data;
    const pc = getOrCreatePeerConnection(fromUserId);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const payload = { targetUserId: fromUserId, answer };
    socket.emit('answer', {
        targetUserId: fromUserId,
        answer
    });
    logToViewport('SENT', 'answer', payload);
});

// Handle incoming call answer
socket.on('answer', async (data) => {
    logToViewport('RECEIVED', 'answer', data);
    const { fromUserId, answer } = data;
    const pc = getOrCreatePeerConnection(fromUserId);
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

// Handle incoming ICE candidate
socket.on('ice-candidate', async (data) => {
    // No logging here, it's too noisy.
    const { fromUserId, candidate } = data;
    const pc = getOrCreatePeerConnection(fromUserId);
    // Add candidate if remote description is set
    if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
});

// Handle incoming chat message
socket.on('chat-message', (data) => {
    logToViewport('RECEIVED', 'chat-message', data);
    const { fromUserId, message } = data;
    addMessageToHistory(fromUserId, fromUserId, message);
    // If we are currently chatting with this user, display the message
    if (currentChatPartner === fromUserId) {
        displayMessage(fromUserId, message);
    }
});

// --- WebRTC Functions ---

/**
 * Gets an existing PeerConnection for a user or creates a new one.
 * @param {string} targetUserId - The ID of the other user.
 * @returns {RTCPeerConnection}
 */
function getOrCreatePeerConnection(targetUserId) {
    if (peerConnections[targetUserId]) {
        return peerConnections[targetUserId];
    }

    const pc = new RTCPeerConnection(servers);
    peerConnections[targetUserId] = pc;

    // Add local stream tracks to the connection
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    // When a remote stream is added, show it in the remote video element
    pc.ontrack = event => {
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };

    // Send ICE candidates to the other peer
    pc.onicecandidate = event => {
        if (event.candidate) {
            const payload = { targetUserId, candidate: event.candidate };
            socket.emit('ice-candidate', payload);
            // No logging here, it's too noisy.
        }
    };

    return pc;
}

/**
 * Initiates a call to a target user.
 * @param {string} targetUserId
 */
async function startCall(targetUserId) {
    const pc = getOrCreatePeerConnection(targetUserId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const payload = { targetUserId, offer };
    socket.emit('offer', payload);
    logToViewport('SENT', 'offer', payload);
}

// --- UI & Chat Functions ---

/**
 * Handles selecting a user from the list to start a chat/call.
 * @param {string} targetUserId
 */
function selectUserToChat(targetUserId) {
    if (currentChatPartner === targetUserId) return;

    currentChatPartner = targetUserId;

    // Update UI to show who we are chatting with
    document.getElementById('video-chat-container').style.display = 'block';
    chattingWith.textContent = `Chatting with ${targetUserId}`;

    // Highlight active user in the list
    document.querySelectorAll('#userList li').forEach(li => {
        li.classList.toggle('active', li.dataset.userId === targetUserId);
    });

    // Load chat history
    loadChatHistory(targetUserId);

    // Start the WebRTC call
    startCall(targetUserId);
}

function sendChatMessage() {
    const message = chatInput.value.trim();
    if (message && currentChatPartner) {
        const payload = { targetUserId: currentChatPartner, message };
        socket.emit('chat-message', payload);
        logToViewport('SENT', 'chat-message', payload);

        // Add to our own history and display it
        addMessageToHistory(currentChatPartner, myUserId, message);
        displayMessage(myUserId, message);

        chatInput.value = '';
    }
}

function addMessageToHistory(partnerId, sender, message) {
    if (!chatHistories[partnerId]) {
        chatHistories[partnerId] = [];
    }
    chatHistories[partnerId].push({ sender, message });
}

function loadChatHistory(partnerId) {
    chatMessages.innerHTML = '';
    const history = chatHistories[partnerId] || [];
    history.forEach(({ sender, message }) => {
        displayMessage(sender, message);
    });
}

function displayMessage(sender, message) {
    const messageEl = document.createElement('div');
    messageEl.classList.add('message');
    if (sender === myUserId) {
        messageEl.classList.add('self');
    }
    messageEl.innerHTML = `<span class="sender">${sender}:</span> ${message}`;
    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function cleanUpForUser(userId) {
    if (peerConnections[userId]) {
        peerConnections[userId].close();
        delete peerConnections[userId];
    }
    if (currentChatPartner === userId) {
        currentChatPartner = null;
        remoteVideo.srcObject = null;
        document.getElementById('video-chat-container').style.display = 'none';
    }
}

