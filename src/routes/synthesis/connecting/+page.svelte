<script lang="ts">
  import { audioContext } from "$lib/stores/audioContext";
  import { onMount, onDestroy } from "svelte";
  import { db, user } from "$lib/firebase"; // user might not be needed if unauthenticated
  import { query, limitToFirst, ref, set, get, onValue, off, push, remove } from "firebase/database";
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  
  // Add global window properties for the WebRTC connection
  declare global {
    interface Window {
      syntheticPeerConnection: RTCPeerConnection | null;
      syntheticDataChannel: RTCDataChannel | null;
      synthControllerID?: string;
    }
  }

  // --- Interfaces ---
  interface IceSvr {
    urls: string | string[];
    username?: string;
    credential?: string;
  }

  interface PgData {
    iceServers: IceSvr[];
    error?: string;
  }

  // --- Props & State ---
  export let data: PgData;
  $: ({ iceServers, error } = data);
  // $: if (browser && !$user) goto('/synthesis'); // Removed auth check

  let a_cxt: AudioContext | null = null;
  let unsubscribeAudioContext: () => void;

  $: {
      if (unsubscribeAudioContext) {
          unsubscribeAudioContext();
      }
      unsubscribeAudioContext = audioContext.subscribe(v => {
          a_cxt = v;
      });
  }

  onDestroy(() => {
    if (unsubscribeAudioContext) unsubscribeAudioContext();
  });

  let statusMessage = "Initializing...";
  let synthId: string | null = null;
  let targetCtrlId: string | null = null;
  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let dbListeners: (() => void)[] = [];
  let wakeLock: any = null;
  let wakeLockSupported = false;
  let connectionVerified = false;
  let pingInterval: number | null = null;
  let lastPongReceived: number | null = null;
  let reconnecting = false;
  let reconnectAttempts = 0;
  let missedPings = 0; // Track missed pings for more resilient connection handling
  
  // Store status updates in session storage
  const updateStatus = (message: string) => {
    statusMessage = message;
    if (browser) {
      sessionStorage.setItem('statusMessage', message);
      if (dataChannel) {
        sessionStorage.setItem('dataChannelState', dataChannel.readyState);
      }
      sessionStorage.setItem('reconnecting', reconnecting.toString());
      sessionStorage.setItem('reconnectAttempts', reconnectAttempts.toString());
      
      // Store IDs in session storage for reliability
      if (synthId) {
        sessionStorage.setItem('synthId', synthId);
      }
      
      // Always ensure controller ID is stored if we have it
      if (targetCtrlId) {
        console.log(`[updateStatus] Storing controller ID: ${targetCtrlId}`);
        sessionStorage.setItem('synthConnectionId', targetCtrlId);
      }
    }
  };
  
  // Constants for combined connection monitoring
  const CONNECTION_PING_INTERVAL = 3000; // Send ping every 3 seconds
  const CONNECTION_TIMEOUT = 20000; // Consider connection dead after 20 seconds of no response
  const CONNECTION_MISSED_PINGS_THRESHOLD = 3; // Only mark as failed after 3 consecutive missed pings
  
  // Request a wake lock to prevent phone from sleeping
  const requestWakeLock = async () => {
    if (!wakeLockSupported) return;
    
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock active');
      
      // Store wake lock status in session storage
      if (browser) {
        sessionStorage.setItem('wakeLockActive', 'true');
      }
      
      wakeLock.addEventListener('release', () => {
        console.log('Wake Lock released');
        if (browser) {
          sessionStorage.setItem('wakeLockActive', 'false');
        }
      });
    } catch (err) {
      console.error(`Wake Lock error: ${err.name}, ${err.message}`);
      // Don't set error during connection phase to avoid confusion
    }
  };
  
  // Handle visibility change to reacquire wake lock when tab becomes visible again
  const handleVisibilityChange = async () => {
    if (wakeLockSupported && document.visibilityState === 'visible') {
      requestWakeLock();
    }
  };
  
  // Simple ping function for keepalive
  const sendPing = () => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    
    try {
      // Send a simple ping message
      dataChannel.send('ping');
      
      // Only log occasionally to reduce console spam
      if (Math.random() < 0.1) {
        console.log(`[sendPing] Sent ping message`);
      }
    } catch (error) {
      console.error(`[sendPing] Failed to send ping:`, error);
      handleDeadConnection();
    }
  };
  
  // Send acknowledgment for a message
  const sendAck = (messageType: string) => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    
    try {
      // Simple acknowledgment format
      dataChannel.send(`ack:${messageType}`);
      console.log(`[sendAck] Acknowledged ${messageType}`);
    } catch (error) {
      console.error(`[sendAck] Failed to send acknowledgment:`, error);
    }
  };
  
  // Start simple connection monitoring
  const startConnectionMonitoring = () => {
    if (pingInterval) {
      window.clearInterval(pingInterval);
    }
    
    // Reset state
    lastPongReceived = Date.now();
    connectionVerified = false;
    
    // Start ping interval for keepalive and timeout detection
    pingInterval = window.setInterval(() => {
      if (!dataChannel || dataChannel.readyState !== 'open') {
        console.log(`[connectionMonitoring] Data channel not open, state: ${dataChannel?.readyState}`);
        return;
      }
      
      // Send a keepalive ping
      sendPing();
      
      // Check for timeouts
      if (lastPongReceived) {
        const timeSinceLastResponse = Date.now() - lastPongReceived;
        
        if (timeSinceLastResponse > CONNECTION_TIMEOUT) {
          // Increment missed pings counter
          missedPings++;
          console.warn(`[connectionMonitoring] Missed response #${missedPings}, ${timeSinceLastResponse/1000}s since last response`);
          
          // Only disconnect after hitting the threshold
          if (missedPings >= CONNECTION_MISSED_PINGS_THRESHOLD) {
            console.warn(`[connectionMonitoring] Connection timed out after ${missedPings} missed responses`);
            handleDeadConnection();
          } else {
            updateStatus(`Connection unstable - retry ${missedPings}/${CONNECTION_MISSED_PINGS_THRESHOLD}`);
          }
        } else if (missedPings > 0) {
          // Reset counter if we're back in timeout window
          console.log(`[connectionMonitoring] Connection recovered, resetting missed pings counter`);
          missedPings = 0;
          updateStatus(`Connected (recovered)`);
        }
      }
    }, CONNECTION_PING_INTERVAL);
    
    console.log(`[startConnectionMonitoring] Started simple connection monitoring`);
  };
  
  // Simple message handler - no complex protocol
  const handleMessage = (message: string) => {
    // Record any valid response for connection monitoring
    lastPongReceived = Date.now();
    
    // Handle different message types
    if (message === 'pong') {
      // Simple pong response to our ping - just record it
      // Only log occasionally to reduce console spam
      if (Math.random() < 0.1) {
        console.log(`[handleMessage] Received pong response`);
      }
    } 
    else if (message === 'verified') {
      // Controller has verified our connection
      console.log(`[handleMessage] Connection verified by controller`);
      connectionVerified = true;
      updateStatus("Connection verified");
      
      // Check if we're still on the connecting page - if we've already auto-navigated
      // from the onopen handler, then we don't need to do anything here
      if (!browser || !window.location.pathname.includes('/synthesis/connecting')) {
        console.log(`[handleMessage] Received verification but already navigated away - ignoring`);
        return;
      }
      
      console.log(`[handleMessage] Starting backup navigation after verification`);
      
      // STEP 1: Stop any ping interval
      if (pingInterval) {
        window.clearInterval(pingInterval);
        pingInterval = null;
      }
      
      // STEP 2: Ensure connection info is stored
      if (browser && targetCtrlId && synthId) {
        console.log(`[handleMessage] Updating connection info for backup navigation`);
        sessionStorage.setItem('synthConnectionId', targetCtrlId);
        sessionStorage.setItem('synthId', synthId);
        sessionStorage.setItem('dataChannelState', 'open');
        window.synthControllerID = targetCtrlId;
      }
      
      // STEP 3: Ensure WebRTC objects are stored globally
      window.syntheticPeerConnection = peerConnection;
      window.syntheticDataChannel = dataChannel;
      
      // STEP 4: Create protective wrapper for the data channel to ensure it remains open
      if (dataChannel) {
        const originalClose = dataChannel.close;
        dataChannel.close = function() {
          console.log(`[Protected DC] Blocking data channel close during verification navigation`);
          // Don't actually close the channel
          return;
        };
      }
      
      // STEP 5: Simple direct navigation - we know the connection works because we received verification
      console.log(`[handleMessage] Executing backup navigation after verification`);
      if (browser && targetCtrlId) {
        try {
          // Use direct window.location for maximum reliability
          window.location.href = `/synthesis/connected?ctrl=${targetCtrlId}&verify=true`;
        } catch (e) {
          console.error(`[handleMessage] Error in backup navigation:`, e);
        }
      }
    }
    else if (message.startsWith('message:')) {
      // Message from controller - display it
      const messageContent = message.substring(8);
      console.log(`[handleMessage] Received message from controller: ${messageContent}`);
      updateStatus(`Message: ${messageContent}`);
      
      // Acknowledge the message
      sendAck('message');
    }
    else {
      // Log any other messages
      console.log(`[handleMessage] Received other message: ${message}`);
    }
  };
  
  // Handle dead connection detection and trigger automatic reconnection
  const handleDeadConnection = () => {
    console.warn(`[handleDeadConnection] Handling dead connection`);
    
    // Clear ping interval
    if (pingInterval) {
      window.clearInterval(pingInterval);
      pingInterval = null;
    }
    
    // Force connection state to closed
    if (peerConnection) {
      try {
        peerConnection.close();
      } catch (e) {
        console.warn(`[handleDeadConnection] Error closing PC:`, e);
      }
      peerConnection = null;
    }
    
    if (dataChannel) {
      try {
        dataChannel.close();
      } catch (e) {
        console.warn(`[handleDeadConnection] Error closing DC:`, e);
      }
      dataChannel = null;
    }
    
    connectionVerified = false;
    reconnecting = true;
    reconnectAttempts = 0;
    updateStatus("Connection lost. Preparing to reconnect...");
    
    // Update reconnection status in session storage
    if (browser) {
      sessionStorage.setItem('reconnecting', 'true');
      sessionStorage.setItem('reconnectAttempts', '0');
    }
    
    // Automatically attempt to reconnect after a short delay
    setTimeout(() => {
      reconnectAttempts = 1;
      console.log("[handleDeadConnection] Attempting to reconnect (attempt 1)...");
      updateStatus("Connection lost. Reconnecting...");
      
      // Update reconnection status in session storage
      if (browser) {
        sessionStorage.setItem('reconnectAttempts', '1');
      }
      
      startSynthesisClient().then(() => {
        // If reconnection succeeds, reset the reconnecting state
        reconnecting = false;
        reconnectAttempts = 0;
      }).catch(err => {
        console.error("[handleDeadConnection] Reconnection attempt 1 failed:", err);
        updateStatus("Reconnection failed. Trying again...");
        
        // Update reconnection status in session storage
        if (browser) {
          sessionStorage.setItem('reconnectAttempts', '1');
          sessionStorage.setItem('reconnecting', 'true');
        }
        
        // If first attempt fails, try again with a longer delay
        setTimeout(() => {
          reconnectAttempts = 2;
          console.log("[handleDeadConnection] Second reconnection attempt...");
          updateStatus(`Reconnection attempt 2...`);
          
          // Update reconnection status in session storage
          if (browser) {
            sessionStorage.setItem('reconnectAttempts', '2');
          }
          
          startSynthesisClient().then(() => {
            // If reconnection succeeds, reset the reconnecting state
            reconnecting = false;
            reconnectAttempts = 0;
          }).catch(err => {
            console.error("[handleDeadConnection] Second reconnection attempt failed:", err);
            updateStatus("Cannot reconnect. Please reload the page.");
            
            // Update reconnection status in session storage
            if (browser) {
              sessionStorage.setItem('reconnectAttempts', '2');
              sessionStorage.setItem('reconnecting', 'true');
            }
            
            // Keep trying with a longer interval
            const retryInterval = setInterval(() => {
              if (!reconnecting) {
                clearInterval(retryInterval);
                return;
              }
              
              reconnectAttempts++;
              console.log(`[handleDeadConnection] Retry attempt ${reconnectAttempts}...`);
              updateStatus(`Reconnection attempt ${reconnectAttempts}...`);
              
              // Update reconnection status in session storage
              if (browser) {
                sessionStorage.setItem('reconnectAttempts', reconnectAttempts.toString());
              }
              
              startSynthesisClient().then(() => {
                // If reconnection succeeds, reset the reconnecting state
                reconnecting = false;
                reconnectAttempts = 0;
                clearInterval(retryInterval);
              }).catch(err => {
                console.error(`[handleDeadConnection] Retry ${reconnectAttempts} failed:`, err);
                // Keep trying until user reloads page or connection succeeds
              });
            }, 10000); // Try every 10 seconds after the first two quick attempts
          });
        }, 5000);
      });
    }, 2000);
  };

  // --- Core Logic ---
  const findActiveController = async (): Promise<string | null> => {
    updateStatus("Searching for an active controller...");
    console.log("[findActiveController] Searching...");
    const controllersRef = ref(db, `activeControllers`);
    const activeQuery = query(controllersRef, limitToFirst(1));
    
    // Check for disconnect markers from previous connections
    if (browser && synthId) {
      // Get any previously stored controller ID before clearing it
      const previousControllerId = sessionStorage.getItem('synthConnectionId');
      
      // If we had a previous controller, check if it has a disconnect marker for us
      if (previousControllerId) {
        try {
          const disconnectRef = ref(db, `synthOffers/${previousControllerId}/${synthId}/disconnected`);
          const disconnectSnapshot = await get(disconnectRef);
          
          if (disconnectSnapshot.exists()) {
            console.warn(`[findActiveController] Found disconnect marker from previous controller ${previousControllerId}`);
            
            // If we find a disconnect marker, try cleaning up our entry
            const oldSynthOfferRef = ref(db, `synthOffers/${previousControllerId}/${synthId}`);
            try {
              await remove(oldSynthOfferRef);
              console.log(`[findActiveController] Cleaned up our previous entry in ${previousControllerId}`);
            } catch (e) {
              console.warn(`[findActiveController] Could not clean up previous entry:`, e);
            }
          }
        } catch (e) {
          console.warn(`[findActiveController] Error checking for disconnect marker:`, e);
        }
      }
    }
    
    // Clear any existing controller ID in session storage
    if (browser) {
      sessionStorage.removeItem('synthConnectionId');
    }

    try {
      const snapshot = await get(activeQuery);
      if (snapshot.exists()) {
        let foundCtrlId: string | null = null;
        snapshot.forEach(childSnap => {
          if (!foundCtrlId) {
            foundCtrlId = childSnap.key;
            
            // Check if the controller entry is actually valid by looking at its value
            const ctrlData = childSnap.val();
            if (!ctrlData || !ctrlData.active) {
              console.warn(`[findActiveController] Found controller ${foundCtrlId} but it appears inactive:`, ctrlData);
              foundCtrlId = null; // Reset if it doesn't look active
            }
          }
        });
        if (foundCtrlId) {
            console.log(`[findActiveController] Found controller: ${foundCtrlId}`);
            updateStatus(`Found controller: ${foundCtrlId}...`);
            
            // Verify controller existence separately to be extra sure
            try {
              const ctrlRef = ref(db, `activeControllers/${foundCtrlId}`);
              const ctrlSnapshot = await get(ctrlRef);
              if (!ctrlSnapshot.exists() || !ctrlSnapshot.val().active) {
                console.error(`[findActiveController] Controller ${foundCtrlId} verified as inactive/missing!`);
                return null;
              }
              console.log(`[findActiveController] Controller ${foundCtrlId} verified as active!`);
            } catch (err) {
              console.error(`[findActiveController] Error verifying controller:`, err);
              return null;
            }
            
            return foundCtrlId;
        }
      }
      console.log("[findActiveController] No active controllers found.");
      updateStatus("No active controllers found. Waiting...");
      return null;
    } catch (err) {
        console.error("[findActiveController] Error querying controllers:", err);
        error = "Failed to search for controllers.";
        updateStatus("Error searching for controllers.");
        return null;
    }
  };

  const setupWebRTCAndConnect = async (ctrlId: string, currentSynthId: string) => {
    if (!iceServers || iceServers.length === 0) {
        console.error("[setupWebRTCAndConnect] No ICE servers configured.");
        error = "ICE server configuration missing.";
        updateStatus("Configuration Error.");
        return;
    }
    
    // Verify controller is still active before proceeding
    const ctrlRef = ref(db, `activeControllers/${ctrlId}`);
    try {
      const ctrlSnapshot = await get(ctrlRef);
      if (!ctrlSnapshot.exists() || !ctrlSnapshot.val().active) {
        console.error(`[setupWebRTCAndConnect] Controller ${ctrlId} is no longer active!`);
        updateStatus("Controller is no longer active. Retrying...");
        
        // Trigger re-search for another controller
        setTimeout(() => {
          startSynthesisClient();
        }, 2000);
        return;
      }
      console.log(`[setupWebRTCAndConnect] Verified controller ${ctrlId} is still active.`);
    } catch (err) {
      console.error(`[setupWebRTCAndConnect] Error verifying controller:`, err);
      updateStatus("Error verifying controller. Retrying...");
      
      // Trigger re-search for another controller
      setTimeout(() => {
        startSynthesisClient();
      }, 2000);
      return;
    }
    
    targetCtrlId = ctrlId;
    console.log(`[setupWebRTCAndConnect] Setting up WebRTC for ctrlId: ${ctrlId}, synthId: ${currentSynthId}`);
    
    // Store the controller ID in session storage
    if (browser) {
      // CRITICALLY IMPORTANT: Ensure ctrlId is correctly stored
      if (ctrlId) {
        console.log(`[setupWebRTCAndConnect] Storing controller ID in session storage: ${ctrlId}`);
        sessionStorage.setItem('synthConnectionId', ctrlId);
        // Also set targetCtrlId globally for redundancy
        targetCtrlId = ctrlId;
        // Add to window for even more redundancy
        window.synthControllerID = ctrlId;
        
        // Force update all ctrl-id elements in the DOM
        try {
          setTimeout(() => {
            const ctrlIdElements = document.querySelectorAll('.ctrl-id');
            ctrlIdElements.forEach(element => {
              element.classList.remove('missing', 'unknown');
              element.classList.add('valid');
              element.textContent = ctrlId;
              console.log(`[setupWebRTCAndConnect] Directly updated controller ID in DOM to: ${ctrlId.substring(0, 6)}`);
            });
          }, 100);
        } catch (e) {
          console.warn(`[setupWebRTCAndConnect] Error updating DOM:`, e);
        }
      } else {
        console.warn(`[setupWebRTCAndConnect] No controller ID available to store`);
      }
    }
    updateStatus(`Connecting to controller ${ctrlId?.substring(0, 8)}...`);

    const pc = new RTCPeerConnection({ iceServers });
    peerConnection = pc;

    pc.onicecandidate = event => {
      if (event.candidate) {
        console.log(`[onicecandidate] Sending ICE candidate for synth ${currentSynthId}`);
        const iceRef = ref(db, `synthOffers/${ctrlId}/${currentSynthId}/synthIce`);
        push(iceRef, event.candidate.toJSON())
            .catch(err => console.error(`[onicecandidate] Error sending ICE candidate:`, err));
      } else {
         console.log(`[onicecandidate] All ICE candidates sent for synth ${currentSynthId}.`);
      }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[oniceconnectionstatechange] ICE state: ${pc.iceConnectionState}`);
        updateStatus(`ICE State: ${pc.iceConnectionState}`);
        
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
            // Failed and closed are terminal states that require reconnection
            console.error(`[oniceconnectionstatechange] ICE connection ${pc.iceConnectionState}.`);
            statusMessage = `Connection Failed/Closed (${pc.iceConnectionState})`;
            
            // Trigger reconnection after a brief delay
            setTimeout(() => {
                if (peerConnection === pc) { // Only if this is still the current peerConnection
                    handleDeadConnection();
                }
            }, 1000);
        }
        else if (pc.iceConnectionState === 'disconnected') {
            // Disconnected is often temporary - WebRTC might recover on its own
            console.warn(`[oniceconnectionstatechange] ICE connection temporarily disconnected`);
            updateStatus(`ICE State: Temporarily Disconnected - Attempting Recovery...`);
            
            // Set a timeout to check if it recovers before triggering reconnection
            setTimeout(() => {
                if (peerConnection === pc && pc.iceConnectionState === 'disconnected') {
                    // Still disconnected after grace period
                    console.warn(`[oniceconnectionstatechange] ICE still disconnected after timeout, triggering recovery`);
                    handleDeadConnection();
                } else if (peerConnection === pc) {
                    console.log(`[oniceconnectionstatechange] ICE recovered to ${pc.iceConnectionState}`);
                    updateStatus(`ICE State: ${pc.iceConnectionState} (Recovered)`);
                }
            }, 7000); // 7-second grace period for recovery
        }
        else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            console.log(`[oniceconnectionstatechange] ICE connection established successfully`);
            updateStatus(`ICE State: ${pc.iceConnectionState}`);
        }
    };
    
    pc.onconnectionstatechange = () => {
        console.log(`[onconnectionstatechange] Connection state: ${pc.connectionState}`);
        updateStatus(`Connection State: ${pc.connectionState}`);
        
        // Also update dataChannelState in session storage
        if (browser) {
          sessionStorage.setItem('dataChannelState', dataChannel?.readyState || 'closed');
        }
        
        if (pc.connectionState === 'connected') {
            updateStatus("Connected!");
        }
        else if (pc.connectionState === 'failed' || 
                pc.connectionState === 'disconnected' || 
                pc.connectionState === 'closed') {
            
            console.log(`[onconnectionstatechange] Peer connection ${pc.connectionState}, initiating reconnection`);
            
            // Trigger reconnection after a brief delay
            setTimeout(() => {
                if (peerConnection === pc) { // Only if this is still the current peerConnection
                    handleDeadConnection();
                }
            }, 1000);
        }
    };

    // Create data channel with more resilient configuration
    const dc = pc.createDataChannel("synthData", {
      ordered: true,          // Guarantee message order
      maxRetransmits: 30      // Allow many retransmission attempts
      // Note: Can't use both maxRetransmits and maxPacketLifeTime together
    });
    dataChannel = dc;
    console.log(`[setupWebRTCAndConnect] Data channel created by synth with enhanced reliability configuration`);
    
    dc.onopen = () => {
        console.log(`[onDataChannelOpen] DC opened for synth ${currentSynthId}`);
        updateStatus("Data Channel Open");
        
        // Update dataChannelState and controller ID in session storage
        if (browser) {
          console.log(`[onDataChannelOpen] Setting data channel as open in session storage`);
          sessionStorage.setItem('dataChannelState', 'open');
          
          // CRITICAL: Always store controller ID in session storage when data channel opens
          if (ctrlId) {
            console.log(`[onDataChannelOpen] Storing controller ID in session storage: ${ctrlId}`);
            sessionStorage.setItem('synthConnectionId', ctrlId);
            
            // Add to window object for redundancy
            window.synthControllerID = ctrlId;
            
            // Force update DOM immediately
            try {
              const ctrlIdElements = document.querySelectorAll('.ctrl-id');
              if (ctrlIdElements.length > 0) {
                ctrlIdElements.forEach(element => {
                  element.classList.remove('missing', 'unknown');
                  element.classList.add('valid');
                  element.textContent = ctrlId;
                  console.log(`[onDataChannelOpen] Directly updated controller ID in DOM to: ${ctrlId.substring(0, 6)}`);
                });
              }
            } catch (e) {
              console.warn(`[onDataChannelOpen] Error updating DOM:`, e);
            }
          }
        }
        
        // Send a greeting message
        dc.send(`Hello Ctrl ${ctrlId?.substring(0,4)}... from Synth ${currentSynthId?.substring(0,4)}...`);
        
        // Start simple connection monitoring
        startConnectionMonitoring();
        
        // Update status
        updateStatus("Connection established");
        
        // Use our new navigation utilities to handle this safely
        import { prepareForNavigation, navigateWithProtection, createHeartbeatMechanism } from '$lib/webrtc';
        
        // 1. Prepare WebRTC objects for safe navigation
        prepareForNavigation(dataChannel, peerConnection, ctrlId);
        
        // 2. Setup heartbeat mechanism to keep connection alive during navigation
        const heartbeatIntervals = createHeartbeatMechanism(dataChannel, ctrlId);
        
        // 3. Perform the actual navigation with our utility
        navigateWithProtection({
          ctrlId,
          url: '/synthesis/connected',
          params: {
            auto: 'true',
            protect: 'ultra'
          },
          ensureTimeout: 250,
          retryCount: 2,
          synthetic: true // Use direct location.href for navigation
        });
    };
    dc.onmessage = e => {
        const message = e.data;
        
        // Log message size for diagnostic purposes
        console.log(`[onDataChannelMessage] Received message of size ${message.length} bytes: ${message}`);
        
        // Handle explicit disconnect message from controller
        if (message === 'ctrl:disconnect') {
            console.warn(`[onDataChannelMessage] Received explicit disconnect signal from controller`);
            updateStatus("Controller initiated disconnect");
            handleDeadConnection();
            return;
        }
        
        // Simply pass all regular messages to our message handler
        handleMessage(message);
    };
    dc.onclose = () => {
        console.log(`[onDataChannelClose] DC closed for synth ${currentSynthId}`);
        updateStatus("Data Channel Closed");
        
        // Update dataChannelState in session storage
        if (browser) {
          sessionStorage.setItem('dataChannelState', 'closed');
        }
        
        // Trigger reconnection after a brief delay
        setTimeout(() => {
          if (dataChannel === dc) { // Only if this is still the current dataChannel
            handleDeadConnection();
          }
        }, 1000);
    };
    dc.onerror = e => {
        console.warn(`[onDataChannelError] DC issue for synth ${currentSynthId}:`, e);
        
        // Check for User-Initiated Abort errors, which are normal during clean disconnect
        const isUserInitiatedAbort = 
            e.error && 
            e.error.message && 
            (e.error.message.includes("User-Initiated Abort") || 
             e.error.message.includes("Close called"));
            
        if (isUserInitiatedAbort) {
            console.log(`[onDataChannelError] Normal close-related error, handling gracefully`);
            // No status change needed for clean disconnects
            // The onclose handler will manage the state transition
            
            // Even though this is a normal close-related error, let's update the session storage
            // to keep our state consistent
            if (browser) {
              // Store actual current state, not "error"
              sessionStorage.setItem('dataChannelState', dataChannel?.readyState || 'closing');
              
              // If we detect this is happening as part of a controller-initiated disconnect,
              // let's immediately prepare for that to avoid weird state transitions
              if (dataChannel?.readyState === 'closing' || dataChannel?.readyState === 'closed') {
                console.log(`[onDataChannelError] User-Initiated Abort during ${dataChannel?.readyState} state - part of normal disconnect flow`);
                
                // This is expected during controller-initiated disconnection or reconnection
                // No need to trigger reconnection process as this is part of normal controller-side cleanup
              }
            }
        } else {
            // Only update status for real errors
            updateStatus("Data Channel Error");
            
            // Update dataChannelState in session storage
            if (browser) {
              sessionStorage.setItem('dataChannelState', dataChannel?.readyState || 'error');
            }
        }
    };

    try {
        const offer = await pc.createOffer();
        console.log(`[setupWebRTCAndConnect] Offer created by synth.`);

        await pc.setLocalDescription(offer);
        console.log(`[setupWebRTCAndConnect] Local description (offer) set by synth.`);

        const offerPath = `synthOffers/${ctrlId}/${currentSynthId}/offer`;
        console.log(`[setupWebRTCAndConnect] Attempting to write offer to: ${offerPath}`);
        try {
            await set(ref(db, offerPath), offer.sdp);
            console.log(`[setupWebRTCAndConnect] Offer successfully sent to Firebase at ${offerPath}`);
            updateStatus("~ offer sent, waiting for answer ~");
        } catch (writeError) {
            console.error(`[setupWebRTCAndConnect] FIREBASE WRITE ERROR sending offer:`, writeError);
            error = "Failed to send offer to controller.";
            updateStatus("Error sending offer.");
            cleanup();
            return;
        }

        const answerRef = ref(db, `synthOffers/${ctrlId}/${currentSynthId}/answer`);
        const answerListener = onValue(answerRef, async (snapshot) => {
            const answerSdp = snapshot.val();
            if (answerSdp && pc.signalingState === 'have-local-offer') {
                console.log(`[answerListener] Received answer from controller.`);
                try {
                    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
                    console.log(`[answerListener] Remote description (answer) set by synth.`);
                    updateStatus("Answer received, connecting...");
                    addControllerIceListener(pc, ctrlId, currentSynthId);
                } catch (err) {
                    console.error(`[answerListener] Error setting remote description (answer):`, err);
                    error = "Failed to process controller's answer.";
                    updateStatus("Error processing answer.");
                }
            } else if (answerSdp && pc.signalingState !== 'have-local-offer') {
                 console.warn(`[answerListener] Received answer but signaling state is unexpected: ${pc.signalingState}`);
            }
        }, (err) => {
            console.error(`[answerListener] Firebase error listening for answer:`, err);
            error = "Error receiving answer from controller.";
            updateStatus("Error receiving answer.");
        });
        dbListeners.push(() => off(answerRef, 'value', answerListener));

    } catch (err) {
        console.error(`[setupWebRTCAndConnect] Error during offer/answer process:`, err);
        error = "Failed to initiate connection.";
        updateStatus("Connection Initiation Failed.");
        cleanup();
    }
  };

  const addControllerIceListener = (pc: RTCPeerConnection, ctrlId: string, currentSynthId: string) => {
    const iceRef = ref(db, `synthOffers/${ctrlId}/${currentSynthId}/ctrlIce`);
    console.log(`[addControllerIceListener] Listening for controller ICE at ${iceRef.toString()}`);
    const iceListener = onValue(iceRef, async (snap) => {
        const candidate = snap.val();
        if (candidate && candidate.candidate && pc.signalingState !== 'closed') {
             console.log(`[addControllerIceListener] Received controller ICE candidate.`);
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
                console.log(`[addControllerIceListener] Added controller ICE candidate.`);
            } catch (e) {
                 if (e instanceof DOMException && e.message.includes("Error processing ICE candidate")) {
                    // console.warn(`[addControllerIceListener] Ignoring known ICE processing error: ${e.message}`);
                 } else {
                    console.error(`[addControllerIceListener] Error adding controller ICE candidate:`, e);
                 }
            }
        }
    }, (err) => {
        console.error(`[addControllerIceListener] Firebase error listening for controller ICE:`, err);
        error = "Error receiving connection details.";
        updateStatus("Error receiving connection details.");
    });
    dbListeners.push(() => off(iceRef, 'value', iceListener));
  };

  // --- Initialization and Cleanup ---
  const startSynthesisClient = async () => {
    if (!browser) {
        console.log("[startSynthesisClient] Not in browser environment.");
        return;
    }
    
    // Check for reconnection parameters that indicate we came from the connected page
    const urlParams = new URLSearchParams(window.location.search);
    const isReconnect = urlParams.get('reconnect') === 'true';
    const targetController = urlParams.get('target');
    const failedNavigation = urlParams.get('failedNavigation') === 'true';
    
    if (isReconnect && targetController) {
      console.log(`[startSynthesisClient] Reconnection attempt for controller: ${targetController}`);
      updateStatus("Reconnecting to previous controller...");
    }
    
    if (failedNavigation) {
      console.warn(`[startSynthesisClient] Previous navigation to connected page failed`);
      updateStatus("Reestablishing connection...");
    }
    
    // Check if we have an audio context and if it's allowed to start
    if (a_cxt) {
      console.log(`[startSynthesisClient] AC state: ${a_cxt.state}`);
      
      // If audio context is suspended, we need a user gesture - redirect to root
      if (a_cxt.state === 'suspended') {
        console.warn("[startSynthesisClient] Audio context is suspended, redirecting to root for user gesture");
        goto('/');
        return;
      }
    } else {
      // No audio context - redirect to root for initialization
      console.warn("[startSynthesisClient] No audio context, redirecting to root");
      goto('/');
      return;
    }

    // Generate ID using Firebase Push Key
    synthId = push(ref(db, 'synthOffers')).key;
    if (!synthId) {
        console.error("[startSynthesisClient] Failed to generate Firebase Push ID for synth.");
        error = "Failed to generate synth ID.";
        updateStatus("Initialization Error.");
        return;
    }
    console.log(`[startSynthesisClient] Synth ID: ${synthId}`);
    
    // Store synth ID in session storage immediately
    if (browser) {
      sessionStorage.setItem('synthId', synthId);
      console.log(`[startSynthesisClient] Stored synth ID in session storage: ${synthId}`);
      
      // Force update DOM immediately
      try {
        setTimeout(() => {
          const synthIdElements = document.querySelectorAll('.synth-id');
          if (synthIdElements.length > 0) {
            synthIdElements.forEach(element => {
              element.textContent = synthId;
              console.log(`[startSynthesisClient] Directly updated synth ID in DOM: ${synthId}`);
            });
          }
        }, 100);
      } catch (e) {
        console.warn(`[startSynthesisClient] Error updating DOM:`, e);
      }
    }
    
    updateStatus(`Synth ID: ${synthId.substring(0, 8)}...`);

    const foundCtrlId = await findActiveController();

    if (foundCtrlId) {
      // If we successfully found a controller, we're making progress
      reconnecting = false;
      
      // Store the controller ID in session storage immediately
      if (browser) {
        sessionStorage.setItem('synthConnectionId', foundCtrlId);
        console.log(`[startSynthesisClient] Stored controller ID in session storage: ${foundCtrlId}`);
      }
      
      setupWebRTCAndConnect(foundCtrlId, synthId);
      return foundCtrlId; // Return for promise chaining
    } else {
      console.log("[startSynthesisClient] No controller found initially. Will retry if in reconnection mode.");
      updateStatus("Waiting for a controller to become active...");
      return null; // Return for promise chaining
    }
  };

  const cleanup = () => {
    console.log('[cleanup] Cleaning up Synth client.');
    console.log(`[cleanup] Unsubscribing from ${dbListeners.length} Firebase listeners.`);
     dbListeners.forEach(unsubscribe => {
      try { unsubscribe(); } catch (e) { console.warn("[cleanup] Error during listener unsubscribe:", e); }
    });
    dbListeners = [];
    
    // Clear ping interval
    if (pingInterval) {
      window.clearInterval(pingInterval);
      pingInterval = null;
    }

    if (peerConnection) {
        console.log(`[cleanup] Closing PeerConnection.`);
        try { dataChannel?.close(); } catch (e) { console.warn(`[cleanup] Error closing DC:`, e); }
        try { peerConnection.close(); } catch (e) { console.warn(`[cleanup] Error closing PC:`, e); }
        peerConnection = null;
        dataChannel = null;
    }
    
    connectionVerified = false;

    if (targetCtrlId && synthId) {
        console.log(`[cleanup] Removing database entry for synth offer: synthOffers/${targetCtrlId}/${synthId}`);
        const offerNodeRef = ref(db, `synthOffers/${targetCtrlId}/${synthId}`);
        remove(offerNodeRef).catch(e => console.error("[cleanup] Error removing synth offer node:", e));
    } else {
         console.log("[cleanup] No target controller/synth ID, skipping DB removal.");
    }

    targetCtrlId = null;
    synthId = null;
    console.log("[cleanup] Synth cleanup complete.");
    updateStatus("Connection closed."); // Set final status
    // Optional: Navigate away
    // goto('/synthesis');
  };

  // --- Svelte Lifecycle ---
  onMount(() => {
    if (browser) {
      console.log('[Connecting onMount] Initializing connecting page');
      
      // Always ensure the status shows as connecting
      sessionStorage.setItem('connectionState', 'connecting');
      sessionStorage.setItem('statusMessage', 'Connecting...');
      
      // Check for wake lock support
      if ('wakeLock' in navigator) {
        wakeLockSupported = true;
        
        // Request wake lock
        requestWakeLock();
        
        // Set up event listener for visibility changes
        document.addEventListener('visibilitychange', handleVisibilityChange);
      } else {
        console.warn('Wake Lock API not supported in this browser');
      }
      
      // Simple script to ensure connecting state
      try {
        const connectingScript = `
          console.log('[Connecting] Setting session storage for connecting state');
          sessionStorage.setItem('connectionState', 'connecting');
          sessionStorage.setItem('dataChannelState', '');
          sessionStorage.setItem('statusMessage', 'Connecting...');
        `;
        
        const scriptElement = document.createElement('script');
        scriptElement.textContent = connectingScript;
        document.head.appendChild(scriptElement);
      } catch (e) {
        console.warn('[Connecting onMount] Error injecting script:', e);
      }
    }

    startSynthesisClient().catch(err => {
        console.error("Error starting synth client:", err);
        error = "Failed to start synthesis client.";
        updateStatus("Initialization Error.");
    });

    return () => {
        if (browser && wakeLockSupported) {
          document.removeEventListener('visibilitychange', handleVisibilityChange);
          if (wakeLock) wakeLock.release();
        }
        cleanup();
    };
  });

</script>

<svelte:head>
    <title>Connecting Synth</title>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap&text-rendering=optimizeLegibility" rel="stylesheet">
    <style>
      /* Ensure Fira Code ligatures work properly */
      * {
        font-variant-ligatures: normal;
        -webkit-font-variant-ligatures: normal;
        text-rendering: optimizeLegibility;
      }
    </style>
</svelte:head>

<div class="synthesis-connecting">
  {#if error}
    <div class="error-message">
      <span>ERROR: {error}</span>
    </div>
  {/if}
  
  <!-- Simple connecting message when everything is in the header -->
  <div class="centered-content">
    <div class="connecting-animation"></div>
    <div class="connecting-message">
      {#if reconnecting}
        Reconnecting...
      {:else}
        Connecting to controller...
      {/if}
    </div>
    
    <!-- Instructions at bottom -->
    <div class="instructions">
      {wakeLockSupported ? 'Screen will stay awake while connecting.' : 'Keep app in foreground to maintain connection.'}
    </div>
  </div>
</div>

<style>
  /* Synthesis connecting container */
  .synthesis-connecting {
    width: 100%;
    max-width: 600px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin: 0 auto;
  }
  
  /* Error message styling */
  .error-message {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--color-error-900, rgba(80, 20, 20, 0.7));
    color: var(--color-error-300, rgba(255, 150, 150, 0.95));
    padding: 12px 16px;
    border-radius: 4px;
    font-weight: bold;
    max-width: 100%;
    overflow-wrap: break-word;
    font-size: 0.95rem;
  }
  
  /* Centered content */
  .centered-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 32px 16px;
    margin-top: 40px;
  }
  
  /* Connecting animation */
  .connecting-animation {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    border: 3px solid rgba(150, 180, 220, 0.2);
    border-top-color: rgba(150, 180, 220, 0.8);
    animation: spin 1.5s linear infinite;
  }
  
  .connecting-message {
    font-size: 1.1rem;
    font-weight: 500;
    color: rgba(180, 240, 200, 0.95);
    text-align: center;
  }
  
  /* Instructions */
  .instructions {
    text-align: center;
    color: var(--color-tertiary-400, rgba(150, 180, 200, 0.6));
    font-size: 0.85rem;
    padding: 16px 0;
    margin-top: 24px;
  }
  
  /* Animations */
  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }
  
  @keyframes pulse {
    0% {
      opacity: 0.6;
      transform: scale(0.95);
    }
    50% {
      opacity: 1;
      transform: scale(1.05);
    }
    100% {
      opacity: 0.6;
      transform: scale(0.95);
    }
  }
</style>
