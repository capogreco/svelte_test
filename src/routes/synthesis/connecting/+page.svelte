<script lang="ts">
  import { audioContext } from "$lib/stores/audioContext";
  import { onMount, onDestroy } from "svelte";
  import { db, user } from "$lib/firebase"; // user might not be needed if unauthenticated
  import { query, limitToFirst, ref, set, get, onValue, off, push, remove } from "firebase/database";
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { prepareForNavigation, navigateWithProtection, createHeartbeatMechanism, logger, interceptConsoleLogs } from '$lib/webrtc';
  
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
  
  // Debug timer
  let connectionTimer = 0;
  let connectionStartTime = 0;
  let connectionTimerId: number | null = null;
  
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
  const CONNECTION_TIMEOUT = 30000; // Consider connection dead after 30 seconds of no response (increased from 20s)
  const CONNECTION_MISSED_PINGS_THRESHOLD = 5; // Only mark as failed after 5 consecutive missed pings (increased from 3)
  
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
    // This handles any message as a heartbeat indicator
    lastPongReceived = Date.now();
    
    // Reset missed pings counter when we get any valid response
    if (missedPings > 0) {
      console.log(`[handleMessage] Resetting missed pings counter after receiving message`);
      missedPings = 0;
    }
    
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

    const pc = new RTCPeerConnection({ 
      iceServers,
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    peerConnection = pc;

    // For debugging - track ICE candidates
    let iceCandidateCounter = 0;
    let iceCandidateTypes = {
      host: 0,
      srflx: 0,
      relay: 0,
      prflx: 0,
      empty: 0
    };
    
    pc.onicecandidate = event => {
      if (event.candidate) {
        iceCandidateCounter++;
        // Track candidate types for debugging
        const candidateType = event.candidate.type || 'unknown';
        if (iceCandidateTypes[candidateType] !== undefined) {
          iceCandidateTypes[candidateType]++;
        }
        
        // Log detailed info about the candidate
        console.log(`[onicecandidate] #${iceCandidateCounter} Type: ${candidateType}, Protocol: ${event.candidate.protocol}, Address: ${event.candidate.address}`);
        
        const iceRef = ref(db, `synthOffers/${ctrlId}/${currentSynthId}/synthIce`);
        push(iceRef, event.candidate.toJSON())
            .catch(err => console.error(`[onicecandidate] Error sending ICE candidate:`, err));
      } else {
        // This is the end-of-candidates signal
        iceCandidateTypes.empty++;
        console.log(`[onicecandidate] All ICE candidates sent for synth ${currentSynthId}. Summary: ${JSON.stringify(iceCandidateTypes)}`);
      }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[oniceconnectionstatechange] ICE state: ${pc.iceConnectionState}`);
        logger.info('ICE', `ICE connection state changed to: ${pc.iceConnectionState}`, {
          previous: pc.iceConnectionState,
          connectionState: pc.connectionState,
          signalingState: pc.signalingState,
          timestamp: new Date().toISOString(),
          dcState: dataChannel?.readyState || 'none'
        });
        updateStatus(`ICE State: ${pc.iceConnectionState}`);
        
        if (pc.iceConnectionState === 'failed') {
            // Failed is a state that needs intervention, try to restart ICE
            console.error(`[oniceconnectionstatechange] ICE connection failed.`);
            updateStatus(`ICE State: Failed - Attempting ICE restart...`);
            
            // Try ICE restart
            try {
              pc.restartIce();
              console.log(`[oniceconnectionstatechange] Attempted ICE restart.`);
              
              // Set a timeout to check if restart worked
              setTimeout(() => {
                if (peerConnection === pc && 
                   (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')) {
                  console.error(`[oniceconnectionstatechange] ICE restart didn't recover connection. Triggering reconnection.`);
                  handleDeadConnection();
                }
              }, 8000); // Wait 8 seconds for ICE restart to work
            } catch (e) {
              console.error(`[oniceconnectionstatechange] Failed to restart ICE:`, e);
              // If we can't restart ICE, reconnect
              setTimeout(() => {
                if (peerConnection === pc) {
                  handleDeadConnection();
                }
              }, 1000);
            }
        }
        else if (pc.iceConnectionState === 'closed') {
            // Closed is a terminal state
            console.error(`[oniceconnectionstatechange] ICE connection closed.`);
            statusMessage = `Connection Closed (${pc.iceConnectionState})`;
            
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
                    // Still disconnected after grace period, try ICE restart first
                    console.warn(`[oniceconnectionstatechange] ICE still disconnected after timeout, attempting ICE restart`);
                    
                    try {
                      pc.restartIce();
                      console.log(`[oniceconnectionstatechange] Attempted ICE restart after disconnect timeout.`);
                      
                      // Check if restart worked after another grace period
                      setTimeout(() => {
                        if (peerConnection === pc && 
                           (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed')) {
                          console.warn(`[oniceconnectionstatechange] ICE restart didn't resolve disconnect. Triggering recovery.`);
                          handleDeadConnection();
                        }
                      }, 5000); // 5 second wait after ICE restart
                    } catch (e) {
                      console.error(`[oniceconnectionstatechange] Failed to restart ICE after disconnect:`, e);
                      handleDeadConnection();
                    }
                } else if (peerConnection === pc) {
                    console.log(`[oniceconnectionstatechange] ICE recovered to ${pc.iceConnectionState}`);
                    updateStatus(`ICE State: ${pc.iceConnectionState} (Recovered)`);
                }
            }, 7000); // 7-second initial grace period for recovery
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
            
            // If we previously tried to restart ICE or had connection issues, log recovery
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                console.log(`[onconnectionstatechange] Connection fully recovered with ICE state: ${pc.iceConnectionState}`);
            }
        }
        else if (pc.connectionState === 'failed') {
            console.error(`[onconnectionstatechange] Peer connection failed, attempting ICE restart first`);
            
            // Try ICE restart before full reconnection
            try {
                pc.restartIce();
                console.log(`[onconnectionstatechange] Attempted ICE restart for failed connection.`);
                
                // Give it some time to recover before full reconnection
                setTimeout(() => {
                    if (peerConnection === pc && pc.connectionState !== 'connected') {
                        console.error(`[onconnectionstatechange] Connection still not recovered after ICE restart, initiating full reconnection`);
                        handleDeadConnection();
                    }
                }, 8000);
            } catch (e) {
                console.error(`[onconnectionstatechange] Failed to restart ICE for failed connection:`, e);
                
                // Go straight to reconnection if ICE restart fails
                setTimeout(() => {
                    if (peerConnection === pc) {
                        handleDeadConnection();
                    }
                }, 1000);
            }
        }
        else if (pc.connectionState === 'disconnected') {
            console.warn(`[onconnectionstatechange] Peer connection disconnected, waiting for potential auto-recovery`);
            
            // Set a timeout to check if it recovers or needs intervention
            setTimeout(() => {
                if (peerConnection === pc && pc.connectionState === 'disconnected') {
                    console.warn(`[onconnectionstatechange] Connection still disconnected after grace period, attempting ICE restart`);
                    
                    try {
                        pc.restartIce();
                        console.log(`[onconnectionstatechange] Attempted ICE restart for disconnected connection.`);
                        
                        // Wait a bit more to see if ICE restart helps
                        setTimeout(() => {
                            if (peerConnection === pc && pc.connectionState !== 'connected') {
                                console.error(`[onconnectionstatechange] Connection still not recovered after ICE restart, initiating full reconnection`);
                                handleDeadConnection();
                            }
                        }, 5000);
                    } catch (e) {
                        console.error(`[onconnectionstatechange] Failed to restart ICE for disconnected connection:`, e);
                        handleDeadConnection();
                    }
                }
            }, 5000); // 5-second grace period for auto-recovery
        }
        else if (pc.connectionState === 'closed') {
            console.error(`[onconnectionstatechange] Peer connection closed, initiating reconnection`);
            
            // Closed is terminal, go straight to reconnection
            setTimeout(() => {
                if (peerConnection === pc) {
                    handleDeadConnection();
                }
            }, 1000);
        }
    };

    // Create data channel with ultra-resilient configuration
    const dc = pc.createDataChannel("synthData", {
      ordered: true,          // Guarantee message order
      maxRetransmits: 60,     // Allow extensive retransmission attempts
      priority: 'high'        // Make this a high priority channel
    });
    dataChannel = dc;
    
    // Ensure the buffered amount is reasonable
    dc.bufferedAmountLowThreshold = 64 * 1024; // 64KB
    console.log(`[setupWebRTCAndConnect] Data channel created by synth with enhanced reliability configuration`);
    
    dc.onopen = () => {
        console.log(`[onDataChannelOpen] DC opened for synth ${currentSynthId}`);
        logger.info('DataChannel', `Data channel opened for synth ${currentSynthId}`, {
          readyState: dc.readyState,
          label: dc.label,
          protocol: dc.protocol,
          id: dc.id,
          ordered: dc.ordered,
          maxRetransmits: dc.maxRetransmits
        });
        
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
        logger.info('DataChannel', `Sent greeting message to controller ${ctrlId}`);
        
        // Start simple connection monitoring
        startConnectionMonitoring();
        
        // Start a timer to track how long the connection stays open
        connectionStartTime = Date.now();
        if (connectionTimerId) {
          clearInterval(connectionTimerId);
        }
        connectionTimerId = window.setInterval(() => {
          connectionTimer = Math.floor((Date.now() - connectionStartTime) / 1000);
          if (connectionTimer % 10 === 0) {
            logger.info('ConnectionTimer', `Connection has been open for ${connectionTimer} seconds`);
          }
        }, 1000);
        
        // Update status
        updateStatus("Connection established - Connection stabilizing...");
        
        // Store navigation data in session storage
        if (browser) {
          sessionStorage.setItem('debugMode', 'false');
          sessionStorage.setItem('connectionSuccess', 'true');
          sessionStorage.setItem('connectedAt', Date.now().toString());
          sessionStorage.setItem('connectionStabilizing', 'true');
        }
        
        // Prepare for future navigation, but don't navigate yet
        // 1. Prepare WebRTC objects for safe navigation
        prepareForNavigation(dataChannel, peerConnection, ctrlId);
        
        // 2. Setup heartbeat mechanism to keep connection alive
        const heartbeatIntervals = createHeartbeatMechanism(dataChannel, ctrlId);
        
        // Show a manual navigation button after stabilization period
        setTimeout(() => {
          updateStatus("Connection stabilized - Ready for navigation");
          
          if (browser) {
            // Update session storage to indicate stabilized connection
            sessionStorage.setItem('connectionStabilizing', 'false');
            sessionStorage.setItem('connectionStabilized', 'true');
            
            // Add a manual navigation button to the UI
            const navButtonContainer = document.createElement('div');
            navButtonContainer.style.cssText = `
              position: fixed;
              bottom: 100px;
              left: 50%;
              transform: translateX(-50%);
              z-index: 9999;
              text-align: center;
            `;
            
            const navButton = document.createElement('button');
            navButton.textContent = 'Show Connected View';
            navButton.style.cssText = `
              padding: 12px 24px;
              background: rgba(40, 180, 100, 0.9);
              color: white;
              border: none;
              border-radius: 4px;
              cursor: pointer;
              font-size: 16px;
              font-weight: bold;
              box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
              margin-bottom: 10px;
              display: block;
            `;
            
            const statusText = document.createElement('div');
            statusText.textContent = 'Connection is stable. Click to show connected view.';
            statusText.style.cssText = `
              color: rgba(100, 220, 150, 0.9);
              font-size: 14px;
              margin-top: 8px;
            `;
            
            navButton.onclick = () => {
              // Update the button to show we're preparing
              navButton.textContent = 'Preparing navigation...';
              navButton.disabled = true;
              
              // Enhanced approach: 
              // 1. Store critical objects in multiple places for redundancy
              window.syntheticDataChannel = dataChannel;
              window.syntheticPeerConnection = peerConnection;
              window.synthControllerID = ctrlId;
              
              // 2. Store in session storage for extra backup
              if (browser) {
                // Store connection details for maximum redundancy
                sessionStorage.setItem('synthConnectionId', ctrlId);
                sessionStorage.setItem('dataChannelState', 'open');
                sessionStorage.setItem('connectionState', 'connected');
                sessionStorage.setItem('manualNavigation', 'true');
                sessionStorage.setItem('navigationPrepared', 'true');
                
                try {
                  // Attempt to store WebRTC state
                  sessionStorage.setItem('webrtcState', JSON.stringify({
                    ctrlId,
                    timestamp: Date.now(),
                    synthId: synthId
                  }));
                } catch (e) {
                  console.warn(`[Navigation] Could not store webrtcState:`, e);
                }
              }
              
              // 3. Make the DC and PC immune to garbage collection by storing in a global array
              if (!window._persistConnections) {
                window._persistConnections = [];
              }
              window._persistConnections.push({
                dc: dataChannel,
                pc: peerConnection,
                ctrlId,
                timestamp: Date.now(),
                synthId
              });
              
              // 4. Create a global protection mechanism
              window.protectedDC = dataChannel;
              window.protectedPC = peerConnection;
              
              // 5. Update the button to show navigation is ready
              setTimeout(() => {
                navButton.textContent = 'Show Connected View';
                navButton.disabled = false;
                
                // 6. Create a function to show connected UI instead of navigating
                navButton.onclick = () => {
                  // Don't navigate - just swap the UI
                  navButton.textContent = 'Loading connected view...';
                  navButton.disabled = true;
                  
                  // Fetch the connected page content
                  fetch('/synthesis/connected')
                    .then(response => response.text())
                    .then(html => {
                      // Find the synthesis-connecting container
                      const connectingContainer = document.querySelector('.synthesis-connecting');
                      if (connectingContainer) {
                        // Extract just the main content from the connected page
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = html;
                        
                        // Find the connected page content
                        const connectedContent = tempDiv.querySelector('.synthesis-content');
                        if (connectedContent) {
                          // Replace the connecting UI with the connected UI
                          console.log(`[Navigation] Replacing UI with connected view`);
                          connectingContainer.innerHTML = '';
                          connectingContainer.appendChild(connectedContent);
                          
                          // Update the URL without navigating using history API
                          const params = new URLSearchParams({
                            ctrl: ctrlId,
                            protect: 'ultra',
                            manual: 'true',
                            timestamp: Date.now().toString()
                          });
                          
                          // Update the URL but stay on the same page
                          window.history.pushState(
                            { 
                              page: 'connected',
                              ctrlId,
                              synthId
                            }, 
                            'Connected Synthesizer', 
                            `/synthesis/connected?${params.toString()}`
                          );
                          
                          // Update page title to match connected page
                          document.title = 'Connected Synthesizer';
                          
                          // Execute any scripts from the connected page
                          // This is important for any JavaScript in the connected page to run
                          const scripts = tempDiv.querySelectorAll('script');
                          scripts.forEach(oldScript => {
                            const newScript = document.createElement('script');
                            Array.from(oldScript.attributes).forEach(attr => {
                              newScript.setAttribute(attr.name, attr.value);
                            });
                            newScript.textContent = oldScript.textContent;
                            document.body.appendChild(newScript);
                          });
                          
                          console.log(`[Navigation] UI swap complete - connection preserved`);
                        } else {
                          console.error(`[Navigation] Could not find connected content in fetched page`);
                        }
                      }
                    })
                    .catch(err => {
                      console.error(`[Navigation] Error fetching connected page:`, err);
                      navButton.textContent = 'Error - Try again';
                      navButton.disabled = false;
                    });
                };
              }, 1000);
            };
            
            navButtonContainer.appendChild(navButton);
            navButtonContainer.appendChild(statusText);
            document.body.appendChild(navButtonContainer);
          }
        }, 6000); // 6 second stabilization period
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
        
        // Stop connection timer
        if (connectionTimerId) {
          clearInterval(connectionTimerId);
          connectionTimerId = null;
        }
        
        // Log the final connection time
        const finalConnectionTime = connectionStartTime > 0 ? 
          Math.floor((Date.now() - connectionStartTime) / 1000) : 0;
        
        logger.error('DataChannel', `❌ Data channel closed for synth ${currentSynthId}`, {
          readyState: dc.readyState,
          iceState: peerConnection?.iceConnectionState,
          connectionState: peerConnection?.connectionState,
          signalingState: peerConnection?.signalingState,
          timestamp: new Date().toISOString(),
          timeOpen: finalConnectionTime > 0 ? `${finalConnectionTime} seconds` : 'unknown',
          lastPong: lastPongReceived ? `${(Date.now() - lastPongReceived) / 1000}s ago` : 'unknown'
        });
        
        updateStatus(`Data Channel Closed (was open for ${finalConnectionTime} seconds)`);
        
        // Update dataChannelState in session storage
        if (browser) {
          sessionStorage.setItem('dataChannelState', 'closed');
        }
        
        // Trigger reconnection after a brief delay
        setTimeout(() => {
          if (dataChannel === dc) { // Only if this is still the current dataChannel
            logger.warn('DataChannel', 'Triggering reconnection due to data channel closure');
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
            logger.info('DataChannel', 'Normal close-related data channel error (User-Initiated Abort)', {
              readyState: dc.readyState,
              iceState: peerConnection?.iceConnectionState,
              connectionState: peerConnection?.connectionState,
              error: e.error?.message || 'Unknown error',
              timestamp: new Date().toISOString()
            });
            
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
            logger.error('DataChannel', `Real data channel error for synth ${currentSynthId}`, {
              readyState: dc.readyState,
              iceState: peerConnection?.iceConnectionState,
              connectionState: peerConnection?.connectionState,
              error: e.error?.message || 'Unknown error',
              timestamp: new Date().toISOString()
            });
            
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
        if (candidate && pc.signalingState !== 'closed') {
            try {
                // Handle both normal candidates and "end-of-candidates" signals
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
                if (candidate.candidate) {
                    console.log(`[addControllerIceListener] Added controller ICE candidate.`);
                } else {
                    // This is a valid end-of-candidates signal
                    console.log(`[addControllerIceListener] Added end-of-candidates signal.`);
                }
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
      
      // Log issue but don't redirect so we can see logs
      if (a_cxt.state === 'suspended') {
        console.warn("[startSynthesisClient] Audio context is suspended, but continuing for debugging");
        updateStatus("⚠️ Audio context suspended (debug mode)");
        // Don't redirect to allow for debugging
      }
    } else {
      // Log issue but don't redirect
      console.warn("[startSynthesisClient] No audio context, but continuing for debugging");
      updateStatus("⚠️ No audio context (debug mode)");
      // Don't redirect to allow for debugging
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
    
    // Configure logger with synth ID
    logger.setClient('synth', synthId);
    logger.info('Setup', `Synthesis client initialized with ID: ${synthId}`);
    
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
      
      // Initialize logger
      interceptConsoleLogs();
      logger.info('Mount', 'Synthesis connecting page initialized');
      
      // Create a UI element to view logs
      const logButtonContainer = document.createElement('div');
      logButtonContainer.style.cssText = `
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 9999;
      `;
      
      const logButton = document.createElement('button');
      logButton.textContent = 'View Logs';
      logButton.style.cssText = `
        padding: 8px 16px;
        background: rgba(60, 70, 90, 0.8);
        color: white;
        border: 1px solid rgba(100, 140, 180, 0.5);
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      `;
      
      logButton.onclick = () => {
        logger.displayLogUI();
      };
      
      logButtonContainer.appendChild(logButton);
      document.body.appendChild(logButtonContainer);
      
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
</svelte:head>

<script context="module">
  // Debug mode can be toggled via localStorage
  let isDebugMode = false;
  
  if (typeof window !== 'undefined') {
    isDebugMode = localStorage.getItem('debugMode') === 'true';
  }
</script>

<div class="synthesis-connecting">
  {#if error}
    <div class="error-message">
      <span>ERROR: {error}</span>
    </div>
  {/if}
  
  <!-- Simplified connection UI -->
  <div class="centered-content">
    <div class="connecting-animation"></div>
    <div class="connecting-message">
      {#if reconnecting}
        Reconnecting...
      {:else}
        Connecting to controller...
      {/if}
    </div>
    
    <!-- Simplified status message -->
    <div class="status-message">{statusMessage}</div>
    
    {#if dataChannel && dataChannel.readyState === 'open' && connectionTimer > 5}
      <div class="navigation-container" class:ready={connectionTimer > 6}>
        <button class="navigation-button" 
          disabled={connectionTimer < 6} 
          on:click={() => {
            // Don't navigate - just swap the UI
            const button = document.querySelector('.navigation-button') as HTMLButtonElement;
            button.textContent = 'Loading...';
            button.disabled = true;
            
            // Store critical objects in multiple places for redundancy
            window.syntheticDataChannel = dataChannel;
            window.syntheticPeerConnection = peerConnection;
            window.synthControllerID = targetCtrlId;
            
            // Store in global array to prevent garbage collection
            if (!window._persistConnections) {
              window._persistConnections = [];
            }
            window._persistConnections.push({
              dc: dataChannel,
              pc: peerConnection,
              ctrlId: targetCtrlId,
              timestamp: Date.now(),
              synthId
            });
            
            // Fetch the connected page content
            fetch('/synthesis/connected')
              .then(response => response.text())
              .then(html => {
                // Find the synthesis-connecting container
                const connectingContainer = document.querySelector('.synthesis-connecting');
                if (connectingContainer) {
                  // Extract just the main content from the connected page
                  const tempDiv = document.createElement('div');
                  tempDiv.innerHTML = html;
                  
                  // Find the connected page content
                  const connectedContent = tempDiv.querySelector('.synthesis-content');
                  if (connectedContent) {
                    // Replace the connecting UI with the connected UI
                    console.log(`[Navigation] Replacing UI with connected view`);
                    connectingContainer.innerHTML = '';
                    connectingContainer.appendChild(connectedContent);
                    
                    // Update the URL without navigating using history API
                    const params = new URLSearchParams({
                      ctrl: targetCtrlId,
                      protect: 'ultra',
                      manual: 'true',
                      timestamp: Date.now().toString()
                    });
                    
                    // Update the URL but stay on the same page
                    window.history.pushState(
                      { 
                        page: 'connected',
                        ctrlId: targetCtrlId,
                        synthId
                      }, 
                      'Connected Synthesizer', 
                      `/synthesis/connected?${params.toString()}`
                    );
                    
                    // Update page title to match connected page
                    document.title = 'Connected Synthesizer';
                    
                    // Execute any scripts from the connected page
                    const scripts = tempDiv.querySelectorAll('script');
                    scripts.forEach(oldScript => {
                      const newScript = document.createElement('script');
                      Array.from(oldScript.attributes).forEach(attr => {
                        newScript.setAttribute(attr.name, attr.value);
                      });
                      newScript.textContent = oldScript.textContent;
                      document.body.appendChild(newScript);
                    });
                    
                    console.log(`[Navigation] UI swap complete - connection preserved`);
                  } else {
                    console.error(`[Navigation] Could not find connected content in fetched page`);
                  }
                }
              })
              .catch(err => {
                console.error(`[Navigation] Error fetching connected page:`, err);
                const button = document.querySelector('.navigation-button') as HTMLButtonElement;
                if (button) {
                  button.textContent = 'Error - Try again';
                  button.disabled = false;
                }
              });
          }}>
          Continue to Synthesizer
        </button>
        {#if connectionTimer < 6}
          <div class="stabilizing-message">Connection stabilizing... ({6-connectionTimer}s)</div>
        {/if}
      </div>
    {/if}
    
    <!-- Optional debug toggle that only shows in the interface -->
    <button class="debug-toggle" on:click={() => {
      isDebugMode = !isDebugMode;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('debugMode', isDebugMode.toString());
      }
    }}>
      {isDebugMode ? 'Hide Debug Info' : 'Show Debug Info'}
    </button>
    
    <!-- Debug information panel (only shown if debug mode is enabled) -->
    {#if isDebugMode}
      <div class="debug-panel">
        <div class="debug-title">Debug Information</div>
        <div class="debug-item">
          <span class="debug-label">Status:</span>
          <span class="debug-value">{statusMessage}</span>
        </div>
        {#if peerConnection}
          <div class="debug-item">
            <span class="debug-label">ICE State:</span>
            <span class="debug-value">{peerConnection.iceConnectionState}</span>
          </div>
          <div class="debug-item">
            <span class="debug-label">Connection State:</span>
            <span class="debug-value">{peerConnection.connectionState}</span>
          </div>
        {/if}
        {#if dataChannel}
          <div class="debug-item">
            <span class="debug-label">DataChannel:</span>
            <span class="debug-value">{dataChannel.readyState}</span>
          </div>
          {#if dataChannel.readyState === 'open' && connectionTimer > 0}
            <div class="debug-item">
              <span class="debug-label">Connection Time:</span>
              <span class="debug-value">{connectionTimer} seconds</span>
            </div>
          {/if}
        {/if}
        
        <!-- Debug actions -->
        <div class="debug-actions">
          <button class="debug-button view-logs" on:click={() => logger.displayLogUI()}>
            View Logs
          </button>
          <button class="debug-button save-logs" on:click={() => logger.saveToFile('connection-debug')}>
            Save Logs
          </button>
        </div>
      </div>
    {/if}
    
    <!-- Instructions at bottom -->
    {#if !dataChannel || dataChannel.readyState !== 'open'}
      <div class="instructions">
        {wakeLockSupported ? 'Screen will stay awake while connecting.' : 'Keep app in foreground to maintain connection.'}
      </div>
    {/if}
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
    align-items: center;
    margin: 0 auto;
  }
  
  /* Error message styling */
  .error-message {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(80, 20, 20, 0.7);
    color: rgba(255, 150, 150, 0.95);
    padding: 12px 16px;
    border-radius: 4px;
    font-weight: bold;
    max-width: 100%;
    margin-bottom: 16px;
    width: 100%;
  }
  
  /* Centered content */
  .centered-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 32px 16px;
    margin-top: 20px;
    width: 100%;
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
  
  .status-message {
    font-size: 0.9rem;
    color: rgba(150, 180, 220, 0.8);
    text-align: center;
    max-width: 300px;
  }
  
  .navigation-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 20px;
    opacity: 0.7;
    transition: opacity 0.3s ease;
  }
  
  .navigation-container.ready {
    opacity: 1;
  }
  
  .navigation-button {
    padding: 12px 24px;
    background: rgba(40, 180, 100, 0.9);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 16px;
    font-weight: bold;
    transition: all 0.2s ease;
  }
  
  .navigation-button:disabled {
    background: rgba(40, 180, 100, 0.4);
    cursor: wait;
  }
  
  .navigation-button:not(:disabled):hover {
    background: rgba(50, 200, 120, 1);
    transform: translateY(-2px);
  }
  
  .stabilizing-message {
    font-size: 0.8rem;
    color: rgba(150, 180, 220, 0.7);
    margin-top: 8px;
  }
  
  /* Instructions */
  .instructions {
    text-align: center;
    color: rgba(150, 180, 200, 0.6);
    font-size: 0.85rem;
    padding: 16px 0;
    margin-top: 16px;
  }
  
  /* Debug toggle */
  .debug-toggle {
    background: transparent;
    border: 1px solid rgba(100, 150, 180, 0.3);
    color: rgba(100, 150, 180, 0.5);
    padding: 4px 8px;
    font-size: 0.75rem;
    border-radius: 4px;
    margin-top: 20px;
    cursor: pointer;
  }
  
  /* Debug panel styling (only shown when debug mode is on) */
  .debug-panel {
    background: rgba(40, 50, 60, 0.7);
    border: 1px solid rgba(70, 100, 130, 0.4);
    border-radius: 8px;
    padding: 16px;
    margin-top: 16px;
    max-width: 500px;
    width: 100%;
    font-family: monospace;
    font-size: 0.85rem;
  }
  
  .debug-title {
    color: rgba(180, 200, 220, 0.9);
    font-size: 1rem;
    font-weight: bold;
    text-align: center;
    margin-bottom: 12px;
    border-bottom: 1px solid rgba(70, 100, 130, 0.4);
    padding-bottom: 8px;
  }
  
  .debug-item {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    border-bottom: 1px dotted rgba(70, 100, 130, 0.2);
  }
  
  .debug-label {
    color: rgba(150, 180, 200, 0.8);
    font-weight: bold;
    padding-right: 12px;
  }
  
  .debug-value {
    color: rgba(180, 240, 200, 0.95);
    word-break: break-all;
  }
  
  /* Debug actions */
  .debug-actions {
    display: flex;
    justify-content: space-around;
    margin-top: 16px;
    border-top: 1px solid rgba(70, 100, 130, 0.4);
    padding-top: 12px;
  }
  
  .debug-button {
    background: rgba(40, 70, 90, 0.6);
    color: rgba(180, 220, 200, 0.9);
    border: 1px solid rgba(70, 130, 180, 0.4);
    border-radius: 4px;
    padding: 8px 16px;
    font-size: 0.85rem;
    cursor: pointer;
  }
  
  /* Animations */
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
</style>
