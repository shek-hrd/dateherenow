/**
 * Network Dating Game - Frontend Application Logic
 *
 * This script handles:
 * - User profile management.
 * - Geolocation for proximity calculation.
 * - Connection to the signaling server via WebSockets.
 * - WebRTC peer-to-peer connection management.
 * - Data channel communication for profiles, likes, and matches.
 * - Dynamic UI updates.
 */
document.addEventListener('DOMContentLoaded', () => {
    // IMPORTANT: Replace this with the URL of your deployed signaling server from Render.com
    const SIGNALING_SERVER_URL = 'https://network-dating-signaler.onrender.com';

    // --- DOM Elements ---
    const myProfileForm = {
        name: document.getElementById('my-name'),
        preferences: document.getElementById('my-preferences'),
        about: document.getElementById('my-about'),
        phone: document.getElementById('my-phone'),
        pictureInput: document.getElementById('my-picture-input'),
        picturePreview: document.getElementById('my-picture-preview'),
    };
    const updateProfileBtn = document.getElementById('update-profile-btn');
    const userList = document.getElementById('user-list');
    const locationStatus = document.getElementById('location-status');
    const userCardTemplate = document.getElementById('user-card-template');
    const serverStatusLight = document.getElementById('server-status');
    const matchNotification = document.getElementById('match-notification');

    // --- State ---
    let myProfile = {
        name: '',
        preferences: '',
        about: '',
        phone: '',
        picture: myProfileForm.picturePreview.src,
        location: null,
    };
    let myId = null;
    // Stores peer connections: { peerId: { pc, dc, userProfile, likedByMe, likesMe } }
    const peers = new Map();

    // =================================================================================
    // --- 1. SIGNALING & INITIALIZATION ---
    // =================================================================================

    const socket = io(SIGNALING_SERVER_URL);

    socket.on('connect', () => {
        myId = socket.id;
        console.log('Connected to signaling server with ID:', myId);
        serverStatusLight.classList.add('connected');
        serverStatusLight.title = 'Connected to Signaling Server';
        // Announce our presence to everyone who is already there.
        socket.emit('new-user-announce', { userId: myId });
    });

    socket.on('disconnect', () => {
        console.warn('Disconnected from signaling server.');
        serverStatusLight.classList.remove('connected');
        serverStatusLight.title = 'Disconnected from Signaling Server';
    });

    // Another user has joined, let's initiate a connection to them.
    socket.on('user-joined', ({ userId }) => {
        console.log('New user joined:', userId, 'I will initiate connection.');
        // The new user initiates the connection, we just wait for their offer.
    });

    // A user has announced their presence (either they just joined, or we just joined).
    // We will initiate the connection to them.
    socket.on('user-announce', ({ userId }) => {
        console.log('Discovered user:', userId, 'Initiating connection.');
        createPeerConnection(userId, true); // true = I am the initiator
    });

    socket.on('user-left', ({ userId }) => {
        console.log('User left:', userId, 'Cleaning up connection.');
        if (peers.has(userId)) {
            peers.get(userId).pc.close();
            peers.delete(userId);
            document.getElementById(`user-${userId}`)?.remove();
        }
    });
    socket.on('signal', async ({ from, signal }) => {
        if (!peers.has(from)) {
            // If we receive a signal from an unknown peer, it's an offer to connect.
            console.log(`Received signal from new peer ${from}. Creating connection.`);
            createPeerConnection(from, false); // false = I am not the initiator
        }
        const { pc } = peers.get(from);
        try {
            if (signal.sdp) {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
                if (signal.type === 'offer') {
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    socket.emit('signal', { to: from, from: myId, signal: pc.localDescription });
                }
            } else if (signal.candidate) {
                await pc.addIceCandidate(new RTCIceCandidate(signal));
            }
        } catch (error) {
            console.error('Error handling signal:', error);
        }
    });

    // =================================================================================
    // --- 2. WEBRTC PEER-TO-PEER LOGIC ---
    // =================================================================================

    /**
     * Creates and configures a new RTCPeerConnection to another user.
     * @param {string} peerId The socket ID of the other user.
     * @param {boolean} isInitiator True if we are starting the connection.
     */
    const createPeerConnection = (peerId, isInitiator) => {
        if (peers.has(peerId) || peerId === myId) return;

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] // Google's public STUN server
        });

        peers.set(peerId, { pc, userProfile: {}, likedByMe: false, likesMe: false });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('signal', { to: peerId, from: myId, signal: { candidate: event.candidate } });
            }
        };

        pc.ondatachannel = (event) => {
            const dc = event.channel;
            console.log(`Data channel received from ${peerId}`);
            setupDataChannel(peerId, dc);
        };

        pc.oniceconnectionstatechange = () => {
            updateConnectionStateIndicator(peerId, pc.iceConnectionState);
            updateConnectionStats(peerId);
        };

        if (isInitiator) {
            const dc = pc.createDataChannel('profile-exchange');
            setupDataChannel(peerId, dc);
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    socket.emit('signal', { to: peerId, from: myId, signal: pc.localDescription });
                });
        }
    };

    const setupDataChannel = (peerId, dc) => {
        peers.get(peerId).dc = dc;
        dc.onopen = () => {
            console.log(`Data channel to ${peerId} is open.`);
            sendProfile(peerId); // Send my profile as soon as connection is open
        };
        dc.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'profile') {
                console.log(`Received profile from ${peerId}:`, data.profile);
                peers.get(peerId).userProfile = data.profile;
                updateUserCard(peerId, data.profile);
            }
        };
    };

    // --- Profile & UI ---
    const updateMyProfile = () => {
        myProfile.name = myNameInput.value;
        myProfile.preferences = myPreferencesInput.value;
        myProfile.about = myAboutInput.value;
        myProfile.phone = myPhoneInput.value;
        console.log('My profile updated:', myProfile);
    };

    const sendProfile = (peerId) => {
        const peer = peers.get(peerId);
        if (peer && peer.dc && peer.dc.readyState === 'open') {
            peer.dc.send(JSON.stringify({ type: 'profile', profile: myProfile }));
        }
    };

    const broadcastProfile = () => {
        updateMyProfile();
        peers.forEach((_, peerId) => sendProfile(peerId));
    };

    updateProfileBtn.addEventListener('click', broadcastProfile);

    myPictureInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                myProfile.picture = e.target.result;
                myPicturePreview.src = e.target.result;
                broadcastProfile();
            };
            reader.readAsDataURL(file);
        }
    });

    const createUserCard = (peerId) => {
        if (document.getElementById(`user-${peerId}`)) return;
        const userCard = userCardTemplate.content.cloneNode(true).firstElementChild;
        userCard.id = `user-${peerId}`;
        userList.querySelector('.status-placeholder')?.remove();
        userList.appendChild(userCard);

        userCard.querySelector('.toggle-details-btn').addEventListener('click', (e) => {
            const details = userCard.querySelector('.details');
            details.classList.toggle('visible');
            e.target.textContent = details.classList.contains('visible') ? 'Show Less' : 'Show More';
        });

        userCard.querySelector('.like-btn').addEventListener('click', () => handleLike(peerId));
    };

    /**
     * Updates the content of a user's card with their profile information.
     * @param {string} peerId The ID of the user whose card to update.
     * @param {object} profile The user's profile data.
     */
    const updateUserCard = (peerId, profile) => {
        // Ensure the card exists before trying to update it.
        createUserCard(peerId);
        const userCard = document.getElementById(`user-${peerId}`);
        if (!userCard) return;

        userCard.querySelector('.user-name').textContent = profile.name || 'Anonymous';
        userCard.querySelector('.user-preferences').textContent = profile.preferences || 'Not specified';
        userCard.querySelector('.user-about').textContent = profile.about || 'No bio yet.';
        userCard.querySelector('.user-phone').textContent = profile.phone || 'Not shared';
        userCard.querySelector('.profile-picture-thumb').src = profile.picture;

        // Calculate distance if both have location
        if (myProfile.location && profile.location) {
            const distance = getDistance(myProfile.location, profile.location);
            userCard.querySelector('.distance').textContent = `${distance.toFixed(2)} km`;
        }
    };

    /**
     * Handles the logic when the "Like" button is clicked.
     * @param {string} peerId The ID of the user being liked.
     */
    function handleLike(peerId) {
        const peerState = peers.get(peerId);
        if (!peerState || peerState.likedByMe) return; // Don't do anything if already liked

        console.log(`You liked ${peerId}`);
        peerState.likedByMe = true;

        // Update the button's appearance
        const likeBtn = document.querySelector(`#user-${peerId} .like-btn`);
        likeBtn.classList.add('liked-by-me');
        likeBtn.textContent = '❤️ Liked';

        // Send a 'like' message to the peer
        sendMessage(peerId, { type: 'like' });

        // Check if they already liked us to trigger a match
        if (peerState.likesMe) {
            console.log(`It's a mutual match with ${peerId}!`);
            showMatch(peerId);
        }
    }

    /**
     * Triggers the UI animations and state changes for a match.
     * @param {string} peerId The ID of the matched user.
     */
    function showMatch(peerId) {
        // Show the global match notification banner
        matchNotification.querySelector('p').textContent = `It's a match with ${peers.get(peerId).userProfile.name || 'Anonymous'}!`;
        matchNotification.classList.add('show');
        setTimeout(() => matchNotification.classList.remove('show'), 4000);

        // Show the heart icon on the user's card
        const userCard = document.getElementById(`user-${peerId}`);
        if (userCard) {
            const matchIcon = userCard.querySelector('.match-status');
            matchIcon.textContent = '💞';
            matchIcon.classList.add('visible');
        }
    }

    // =================================================================================
    // --- 4. GEOLOCATION & CONNECTION STATS ---
    // =================================================================================

    const getGeolocation = () => {
        if ('geolocation' in navigator) {
            locationStatus.textContent = 'Getting location...';
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    myProfile.location = {
                        lat: position.coords.latitude,
                        lon: position.coords.longitude,
                    };
                    locationStatus.textContent = `Location acquired. Accuracy: ${position.coords.accuracy.toFixed(0)}m`;
                    broadcastProfile();
                },
                (error) => {
                    locationStatus.textContent = `Location error: ${error.message}`;
                },
                { enableHighAccuracy: true }
            );
        } else {
            locationStatus.textContent = 'Geolocation is not available.';
        }
    };

    /**
     * Calculates the distance in kilometers between two lat/lon points.
     * @param {object} loc1 { lat, lon }
     * @param {object} loc2 { lat, lon }
     */
    const getDistance = (loc1, loc2) => {
        const R = 6371; // Radius of the Earth in km
        const dLat = (loc2.lat - loc1.lat) * (Math.PI / 180);
        const dLon = (loc2.lon - loc1.lon) * (Math.PI / 180);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(loc1.lat * (Math.PI / 180)) * Math.cos(loc2.lat * (Math.PI / 180)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    };

    /**
     * Periodically checks the WebRTC connection stats to update latency and connection type.
     * @param {string} peerId The ID of the peer whose stats to check.
     */
    const updateConnectionStats = async (peerId) => {
        const peer = peers.get(peerId);
        if (!peer || !peer.pc) return;
        const userCard = document.getElementById(`user-${peerId}`);
        if (!userCard) return;

        // getStats() is a built-in WebRTC function
        const stats = await peer.pc.getStats();
        let selectedCandidatePair;
        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                selectedCandidatePair = report;
            }
        });

        if (selectedCandidatePair) {
            // Latency
            const latency = selectedCandidatePair.currentRoundTripTime * 1000;
            userCard.querySelector('.latency').textContent = `${latency.toFixed(0)} ms`;

            // Connection Type (Route Hint)
            const remoteCandidate = stats.get(selectedCandidatePair.remoteCandidateId);
            if (remoteCandidate) {
                // 'host' = Direct LAN, 'srflx' = NAT Traversal, 'relay' = Relayed via TURN server
                const routeType = {
                    host: 'Direct (LAN)',
                    srflx: 'Direct (NAT)',
                    relay: 'Relayed'
                }[remoteCandidate.candidateType] || 'Unknown';
                userCard.querySelector('.user-connection-type').textContent = routeType;
            }
        }
    };

    /** Updates the colored dot on a user card to show their connection status. */
    const updateConnectionStateIndicator = (peerId, state) => {
        const dot = document.querySelector(`#user-${peerId} .connection-status-dot`);
        if (!dot) return;
        dot.classList.remove('connected', 'failed');
        if (state === 'connected') {
            dot.classList.add('connected');
            dot.title = 'P2P Connected';
        } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
            dot.classList.add('failed');
            dot.title = `P2P Disconnected (${state})`;
        }
    };

    // --- Initial Load & Timers ---
    getGeolocation();
    setInterval(() => peers.forEach((_, peerId) => updateConnectionStats(peerId)), 3000); // Update stats every 3s
});