<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { audioContext } from '$lib/stores/audioContext';
  import { goto } from '$app/navigation';
  
  // Add global window properties for the WebRTC connection
  declare global {
    interface Window {
      syntheticPeerConnection: RTCPeerConnection | null;
      syntheticDataChannel: RTCDataChannel | null;
      synthControllerID?: string;
    }
  }
  
  import { db } from "$lib/firebase";
  import { onValue, off, ref, get, remove } from "firebase/database";
  
  // Get connection parameters from session storage
  let connectionId = '';
  let latency = 0;
  let synthId = '';
  
  // WebRTC connection state
  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let dbListeners: (() => void)[] = [];
  let pingInterval: number | null = null;
  let lastPongReceived: number | null = null;
  let connectionVerified = true; // We start verified since we came from connecting page
  let missedPings = 0; // Track missed pings for more resilient connection handling
  
  // Constants for combined connection monitoring
  const CONNECTION_PING_INTERVAL = 3000; // Send ping every 3 seconds
  const CONNECTION_TIMEOUT = 20000; // Consider connection dead after 20 seconds of no response
  const CONNECTION_MISSED_PINGS_THRESHOLD = 3; // Only mark as failed after 3 consecutive missed pings
  
  // Audio context state
  let audioCtx: AudioContext | null = null;
  let audioState = 'suspended';
  let audioContextSupported = true; // assume supported until we check
  let oscNode: OscillatorNode | null = null;
  let gainNode: GainNode | null = null;
  
  // UI state
  let currentTime = new Date().toISOString();
  let timeInterval: number;
  let wakeLock: any = null;
  let wakeLockSupported = false;
  
  // Subscribe to the audio context store
  const unsubscribe = audioContext.subscribe(ctx => {
    audioCtx = ctx;
    
    if (audioCtx) {
      audioState = audioCtx.state;
      
      // Set up listener for audioContext state changes
      const handleStateChange = () => {
        if (audioCtx) {
          audioState = audioCtx.state;
        }
      };
      
      audioCtx.addEventListener('statechange', handleStateChange);
      
      return () => {
        if (audioCtx) {
          audioCtx.removeEventListener('statechange', handleStateChange);
        }
      };
    }
  });
  
  // Initialize necessary audio nodes
  function initAudio() {
    if (!audioCtx) return;
    
    // Create oscillator and gain nodes
    oscNode = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();
    
    // Set up the graph
    oscNode.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    // Configure initial settings
    oscNode.frequency.value = 440; // 440Hz = A4
    gainNode.gain.value = 0; // Start silent
    
    // Start the oscillator
    oscNode.start();
    
    console.log('Audio nodes initialized');
  }
  
  // Resume audio context on user interaction
  async function resumeAudioContext() {
    if (!audioCtx) return;
    
    try {
      await audioCtx.resume();
      console.log('AudioContext resumed');
    } catch (err) {
      console.error('Failed to resume AudioContext:', err);
    }
  }
  
  // Wake lock request to keep screen on
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
    }
  };
  
  // Handle visibility change to reacquire wake lock when tab becomes visible again
  const handleVisibilityChange = async () => {
    if (wakeLockSupported && document.visibilityState === 'visible') {
      requestWakeLock();
    }
  };
  
  // Send ping to measure latency and verify connection
  const sendPing = () => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    
    try {
      // Send ping with timestamp
      const pingMsg = `ping:${Date.now()}`;
      dataChannel.send(pingMsg);
      console.log(`[Connected] Sent ping to controller`);
    } catch (error) {
      console.error(`[Connected] Failed to send ping:`, error);
      handleDeadConnection();
    }
  };
  
  // Start ping interval for both latency and connection verification
  const startConnectionMonitoring = () => {
    if (pingInterval) {
      window.clearInterval(pingInterval);
    }
    
    // Initialize timestamp and verification state
    lastPongReceived = Date.now();
    
    // Start sending pings
    pingInterval = window.setInterval(async () => {
      // Check for disconnect marker from controller once per ping interval
      if (connectionId && synthId && missedPings > 0) {
        try {
          // Only check for disconnect marker if we've missed at least one ping
          // This reduces Firebase reads during normal operation
          const foundDisconnect = await checkForDisconnectMarker();
          if (foundDisconnect) {
            // Disconnect marker found, disconnection is handled by checkForDisconnectMarker
            return;
          }
        } catch (e) {
          console.warn(`[Connected ping] Error checking disconnect marker:`, e);
        }
      }
      
      // Check actual connection status (don't trust cached state)
      if (!dataChannel || !peerConnection) {
        console.warn(`[Connected ping] dataChannel or peerConnection is null, can't check connection`);
        return;
      }
      
      // Get actual current states
      const actualDataChannelState = dataChannel.readyState;
      const actualConnectionState = peerConnection.connectionState;
      const actualIceState = peerConnection.iceConnectionState;
      
      // Log if there's a discrepancy between what we cached and what's happening
      if (actualDataChannelState !== 'open' && dataChannel) {
        console.log(`[Connected ping] Data channel not open: ${actualDataChannelState}`);
      }
      
      if (actualConnectionState !== 'connected' && peerConnection) {
        console.log(`[Connected ping] Connection not connected: ${actualConnectionState}`);
      }
      
      if (actualIceState !== 'connected' && actualIceState !== 'completed' && peerConnection) {
        console.log(`[Connected ping] ICE not connected: ${actualIceState}`);
      }
      
      // Validate connection before sending pings
      if (dataChannel && actualDataChannelState === 'open' && peerConnection && 
          (actualConnectionState === 'connected' || actualIceState === 'connected' || actualIceState === 'completed')) {
        
        try {
          sendPing();
          
          // Check for timed-out connection with graduated response
          if (lastPongReceived) {
            const timeSinceLastPong = Date.now() - lastPongReceived;
            
            if (timeSinceLastPong > CONNECTION_TIMEOUT) {
              // Increment missed pings counter
              missedPings++;
              console.warn(`[Connected] Missed ping #${missedPings} (no response for ${timeSinceLastPong/1000}s)`);
              
              // Only disconnect after hitting the threshold
              if (missedPings >= CONNECTION_MISSED_PINGS_THRESHOLD) {
                console.warn(`[Connected] Connection timed out after ${missedPings} missed pings (${timeSinceLastPong/1000}s)`);
                handleDeadConnection(true); // Use delayed handling for potentially recoverable situations
              } else {
                // Try another ping immediately for faster recovery
                try {
                  sendPing();
                  console.log(`[Connected] Sent emergency ping`);
                } catch (e) {
                  console.warn(`[Connected] Failed to send emergency ping:`, e);
                }
              }
            } else if (missedPings > 0) {
              // Reset missed pings if we're within timeout window and had previous misses
              console.log(`[Connected] Connection recovered, resetting missed pings counter`);
              missedPings = 0;
            }
          }
        } catch (e) {
          console.error(`[Connected ping] Error during ping cycle:`, e);
          missedPings++;
          
          if (missedPings >= CONNECTION_MISSED_PINGS_THRESHOLD) {
            console.warn(`[Connected] Connection failed after ${missedPings} errors`);
            handleDeadConnection(true);
          }
        }
      } else if (missedPings === 0) {
        // If we can't send pings due to closed data channel, count this as a missed ping
        missedPings++;
        console.warn(`[Connected] Can't send ping: dataChannel=${actualDataChannelState}, connection=${actualConnectionState}, ice=${actualIceState}`);
      }
    }, CONNECTION_PING_INTERVAL);
    
    console.log(`[Connected] Started connection monitoring`);
  };
  
  // Record for tracking if we've already measured initial latency
  let initialLatencyMeasured = false;
  let connectionStabilizing = false;
  
  // Process pong response for both latency and connection verification
  const handlePong = (pingTimestamp: number) => {
    const roundTripTime = Date.now() - pingTimestamp;
    lastPongReceived = Date.now();
    connectionVerified = true;
    
    // Reset missed pings counter on successful pong
    if (missedPings > 0) {
      console.log(`[Connected] Connection recovered after ${missedPings} missed pings`);
      missedPings = 0;
    }
    
    // Update latency display
    latency = roundTripTime;
    
    // Mark that we've measured initial latency - only happens once
    if (!initialLatencyMeasured && !connectionStabilizing) {
      initialLatencyMeasured = true;
      connectionStabilizing = true;
      
      // **** CRITICAL FIX ****
      // We've observed the data channel closing immediately after the first latency measurement
      // Complete overhaul of the protection mechanism:
      // 1. Instead of nulling the objects (which could cause GC issues),
      //    we'll create a protective wrapper that intercepts and blocks all operations
      // 2. We'll extend the stabilization period significantly
      // 3. We'll add an emergency detection system that forces keeping connections open
      console.log(`[Connected] First latency measurement: ${roundTripTime}ms - stabilizing connection`);
      
      // *** NEW APPROACH: PROTECTIVE WRAPPER ***
      // Rather than nulling the dataChannel (which could cause it to be GC'd),
      // we'll create protective wrappers that intercept any operations during stabilization
      
      // Store real reference to dataChannel
      const realDataChannel = dataChannel;
      
      // Create a safety wrapper for the data channel that will prevent it from being closed
      const dataChannelWrapper = {
        // Forward safe properties directly
        get readyState() { return realDataChannel?.readyState || 'open'; },
        get bufferedAmount() { return realDataChannel?.bufferedAmount || 0; },
        get bufferedAmountLowThreshold() { return realDataChannel?.bufferedAmountLowThreshold || 0; },
        get maxPacketLifeTime() { return realDataChannel?.maxPacketLifeTime; },
        get maxRetransmits() { return realDataChannel?.maxRetransmits; },
        get negotiated() { return realDataChannel?.negotiated; },
        get id() { return realDataChannel?.id; },
        get ordered() { return realDataChannel?.ordered; },
        get protocol() { return realDataChannel?.protocol; },
        get label() { return realDataChannel?.label; },
        // These methods are safe to call during stabilization
        send: (data) => {
          try {
            if (realDataChannel && realDataChannel.readyState === 'open') {
              return realDataChannel.send(data);
            }
            console.log(`[Protected DC] Blocked send during stabilization`);
          } catch (e) {
            console.warn(`[Protected DC] Error in protected send:`, e);
          }
        },
        // Block potentially unsafe operations during stabilization
        close: () => {
          console.log(`[Protected DC] Blocked close attempt during stabilization`);
          // Don't actually close the channel during stabilization
          return;
        }
      };
      
      // Replace the dataChannel with our protected wrapper
      dataChannel = dataChannelWrapper as any;
      
      // Pause any monitoring that might trigger disconnects
      const oldPingInterval = pingInterval;
      if (pingInterval) {
        window.clearInterval(pingInterval);
        pingInterval = null;
        console.log(`[Connected] Temporarily disabled ping interval`);
      }
      
      // After a safe period, restore monitoring with a gentler approach
      const resumeMonitoringAfter = 8000; // Increased to 8 seconds (from 5)
      setTimeout(() => {
        console.log(`[Connected] Connection stabilization period complete`);
        connectionStabilizing = false;
        
        // Restore the real data channel
        if (realDataChannel && realDataChannel.readyState === 'open') {
          console.log(`[Connected] Real data channel is still open, restoring normal operation`);
          dataChannel = realDataChannel;
          
          // Restart ping interval with a new ID, but with gentler checking
          pingInterval = window.setInterval(() => {
            // Only send pings if connection is definitely open
            if (dataChannel && dataChannel.readyState === 'open') {
              try {
                sendPing();
              } catch (e) {
                console.warn(`[Connected] Error in ping after stabilization:`, e);
              }
            }
          }, CONNECTION_PING_INTERVAL);
          
          console.log(`[Connected] Restored normal connection monitoring`);
        } else {
          console.warn(`[Connected] Data channel closed during stabilization period`);
          // Don't restore monitoring - connection is already closed
          // Let normal reconnection mechanisms handle this
        }
      }, resumeMonitoringAfter);
    } else if (connectionStabilizing) {
      // During stabilization period, just log without taking action
      console.log(`[Connected] Latency during stabilization: ${roundTripTime}ms`);
    } else {
      // Normal log for subsequent latency measurements
      console.log(`[Connected] Latency: ${roundTripTime}ms - connection verified!`);
    }
  };
  
  // Handle dead connection detection with delay option for recoverable states
  const handleDeadConnection = (withDelay = false) => {
    console.warn(`[Connected] Handling dead connection${withDelay ? ' with delay' : ''}`);
    
    // If withDelay is true, wait for possible auto-recovery
    if (withDelay) {
      console.log(`[Connected] Waiting for 5 seconds to allow for possible auto-recovery...`);
      setTimeout(() => {
        // Check if we're still connected (may have recovered already)
        if (dataChannel && dataChannel.readyState === 'open' && 
            peerConnection && 
            (peerConnection.iceConnectionState === 'connected' || 
             peerConnection.iceConnectionState === 'completed')) {
          console.log(`[Connected] Connection recovered during delay, not disconnecting`);
          return;
        }
        
        // If we get here, connection didn't recover during the delay period
        console.warn(`[Connected] Connection didn't recover during delay, proceeding with disconnect`);
        performDisconnect();
      }, 5000);
    } else {
      // Immediate disconnect for non-recoverable states
      performDisconnect();
    }
  };
  
  // Actual disconnect implementation
  const performDisconnect = () => {
    // Clear ping interval
    if (pingInterval) {
      window.clearInterval(pingInterval);
      pingInterval = null;
    }
    
    // Clean up Firebase entry for this connection if possible
    if (connectionId && synthId) {
      try {
        const synthOfferRef = ref(db, `synthOffers/${connectionId}/${synthId}`);
        remove(synthOfferRef)
          .then(() => console.log(`[performDisconnect] Removed Firebase entry for synth ${synthId}`))
          .catch(err => console.error(`[performDisconnect] Error removing Firebase entry:`, err));
      } catch (e) {
        console.warn(`[performDisconnect] Error accessing Firebase for cleanup:`, e);
      }
    }
    
    // Clean up everything
    cleanup();
    
    // Go back to connecting page to try to reconnect
    goto('/synthesis/connecting');
  };
  
  // Cleanup function for all resources
  function cleanup() {
    // Clean up WebRTC resources
    if (peerConnection) {
      try { dataChannel?.close(); } catch (e) { console.warn(`[cleanup] Error closing DC:`, e); }
      try { peerConnection.close(); } catch (e) { console.warn(`[cleanup] Error closing PC:`, e); }
      peerConnection = null;
      dataChannel = null;
    }
    
    // Clean up Firebase listeners
    dbListeners.forEach(unsubscribe => {
      try { unsubscribe(); } catch (e) { console.warn("[cleanup] Error during listener unsubscribe:", e); }
    });
    dbListeners = [];
    
    // Clear ping interval (redundant but safe)
    if (pingInterval) {
      window.clearInterval(pingInterval);
      pingInterval = null;
    }
    
    // Clean up audio resources
    if (oscNode) {
      oscNode.stop();
      oscNode.disconnect();
      oscNode = null;
    }
    
    if (gainNode) {
      gainNode.disconnect();
      gainNode = null;
    }
    
    // Release the wake lock
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
    
    // Clear intervals
    if (timeInterval) {
      clearInterval(timeInterval);
    }
    
    // Unsubscribe from stores
    unsubscribe();
  }
  
  // Disconnect and go back to connecting page
  function reconnect() {
    // Clear session storage
    if (browser) {
      sessionStorage.removeItem('synthConnectionId');
      sessionStorage.removeItem('synthLatency');
    }
    
    // Clean up
    cleanup();
    
    // Go back to connecting page
    goto('/synthesis/connecting');
  }
  
  // Function to check if the controller has left a disconnect marker
  const checkForDisconnectMarker = async () => {
    if (!connectionId || !synthId) return false;
    
    try {
      const disconnectRef = ref(db, `synthOffers/${connectionId}/${synthId}/disconnected`);
      const disconnectSnapshot = await get(disconnectRef);
      
      if (disconnectSnapshot.exists()) {
        console.warn(`[checkForDisconnectMarker] Found disconnect marker from controller ${connectionId}`);
        
        // Gracefully disconnect immediately if we find a marker - controller is gone
        handleDeadConnection(false);
        return true;
      }
    } catch (e) {
      console.warn(`[checkForDisconnectMarker] Error checking for disconnect marker:`, e);
    }
    
    return false;
  };
  
  // Regular check for connection state - helps catch disconnects that WebRTC events might miss
  const checkConnectionState = () => {
    if (!browser) return;
    
    // If we don't have peer connection/data channel objects at all, that's definitely disconnected
    if (!peerConnection || !dataChannel) {
      console.warn('[checkConnectionState] No peer connection or data channel objects!');
      handleDeadConnection(false);
      return;
    }
    
    // Get actual current states directly from objects (most reliable)
    const actualDataChannelState = dataChannel.readyState;
    const actualConnectionState = peerConnection.connectionState;
    const actualIceState = peerConnection.iceConnectionState;
    
    console.log(`[checkConnectionState] States - DC: ${actualDataChannelState}, Connection: ${actualConnectionState}, ICE: ${actualIceState}`);
    
    // Update session storage with these real states
    sessionStorage.setItem('dataChannelState', actualDataChannelState);
    sessionStorage.setItem('connectionState', actualConnectionState === 'connected' ? 'connected' : 'disconnected');
    
    // Check for closed/failed conditions, but be more cautious
    // Only disconnect if we have multiple definitive signals of disconnection
    
    // Track the number of indicators suggesting we're disconnected
    let disconnectSignals = 0;
    
    if (actualDataChannelState === 'closed') {
      console.warn('[checkConnectionState] Data channel is definitively closed');
      disconnectSignals += 2; // This is a strong signal
    } else if (actualDataChannelState === 'closing') {
      console.warn('[checkConnectionState] Data channel is in closing state - might be temporary');
      disconnectSignals += 1; // This is a moderate signal
    }
    
    if (actualConnectionState === 'closed') {
      console.warn('[checkConnectionState] Connection is definitively closed');
      disconnectSignals += 2; // This is a strong signal
    } else if (actualConnectionState === 'failed') {
      console.warn('[checkConnectionState] Connection has failed');
      disconnectSignals += 2; // This is a strong signal
    } else if (actualConnectionState === 'disconnected') {
      console.warn('[checkConnectionState] Connection is in disconnected state - might recover');
      disconnectSignals += 1; // This is a moderate signal
    }
    
    if (actualIceState === 'failed') {
      console.warn('[checkConnectionState] ICE connection has failed');
      disconnectSignals += 1; // This is a moderate signal on its own
    }
    
    // Only trigger a disconnection if we have enough signals to be confident
    // that we're actually disconnected, not just in a temporary state
    if (disconnectSignals >= 2) {
      console.warn(`[checkConnectionState] Multiple disconnect signals (${disconnectSignals}) indicate connection is likely dead`);
      handleDeadConnection(disconnectSignals === 2); // Use delay only for moderate signals
    } else if (disconnectSignals === 1) {
      console.log('[checkConnectionState] Single disconnect signal detected - monitoring but not disconnecting yet');
      // Don't disconnect on a single moderate signal
    }
  };
  
  // Lifecycle hooks
  onMount(() => {
    // Get connection parameters from session storage
    if (browser) {
      console.log('[Connected onMount] Initializing connected page');
      
      // Debug session storage
      console.log('[Connected DEBUG] Session storage contents:');
      Object.keys(sessionStorage).forEach(key => {
        console.log(`  - ${key}: ${sessionStorage.getItem(key)}`);
      });
      connectionId = sessionStorage.getItem('synthConnectionId') || '';
      latency = parseInt(sessionStorage.getItem('synthLatency') || '0');
      synthId = sessionStorage.getItem('synthId') || '';
      
      // Extract URL parameters
      const urlParams = new URLSearchParams(window.location.search);
      const ctrlParam = urlParams.get('ctrl');
      const attemptParam = urlParams.get('attempt');
      const rescueParam = urlParams.get('rescue');
      
      // If this was a rescue navigation, log that for debugging
      if (rescueParam) {
        console.log(`[Connected] This is a rescue navigation attempt`);
      }
      
      // Log navigation attempt number if present
      if (attemptParam) {
        console.log(`[Connected] This is navigation attempt #${attemptParam}`);
      }
      
      // If no connection ID, try multiple fallbacks before redirecting
      if (!connectionId) {
        console.warn("[Connected] No connection ID found in session storage");
        
        // Try to get connection ID from URL params if available
        if (ctrlParam) {
          connectionId = ctrlParam;
          console.log(`[Connected] Got controller ID from URL: ${connectionId}`);
          sessionStorage.setItem('synthConnectionId', connectionId);
        } 
        // Try to get from global WebRTC connection if available
        else if (window.syntheticPeerConnection && window.syntheticDataChannel) {
          console.log(`[Connected] WebRTC connection exists but no ID - using fallback to 'unknown'`);
          connectionId = 'unknown'; // Allow connection with unknown ID as last resort
          sessionStorage.setItem('synthConnectionId', connectionId);
        } 
        // Last resort: redirect to connecting page
        else {
          console.error("[Connected] No controller ID available from any source - redirecting");
          goto('/synthesis/connecting');
          return;
        }
      }
      
      // Use our WebRTC utilities for clean recovery
      import { recoverConnectionAfterNavigation, protectDataChannel, protectPeerConnection, createHeartbeatMechanism } from '$lib/webrtc';
      
      // Get navigation attempts from session storage
      const navigationAttempts = parseInt(sessionStorage.getItem('navigationAttempts') || '0');
      
      // Try to recover connection from previous page
      const recoveryResult = recoverConnectionAfterNavigation();
      
      if (recoveryResult.success) {
        // We successfully recovered the objects!
        console.log(`[Connected] ✅ Successfully recovered WebRTC objects`);
        
        // Set the recovered objects to our local variables
        peerConnection = recoveryResult.peerConnection;
        dataChannel = recoveryResult.dataChannel;
        connectionId = recoveryResult.connectionId || connectionId;
        
        // Apply continued protection and setup heartbeat
        protectDataChannel(dataChannel, connectionId);
        protectPeerConnection(peerConnection, connectionId);
        const heartbeatIntervals = createHeartbeatMechanism(dataChannel, connectionId);
        
        // Set a success message
        try {
          const connectedStatus = document.querySelector('.connected-status');
          if (connectedStatus) {
            connectedStatus.textContent = "Connection successfully established!";
            connectedStatus.style.color = "#50f090";
          }
        } catch (e) {
          console.warn(`[Connected] Error updating UI:`, e);
        }
      } else {
        console.warn("[Connected] WebRTC objects couldn't be recovered - attempting reconnection");
        
        // Don't attempt too many reconnections
        if (connectionId && navigationAttempts < 4) {
          // Update the counter
          const newAttempt = navigationAttempts + 1;
          sessionStorage.setItem('navigationAttempts', newAttempt.toString());
          
          // Show a reconnecting message to the user
          try {
            const connectedMessage = document.querySelector('.connected-message');
            const connectedStatus = document.querySelector('.connected-status');
            if (connectedMessage) connectedMessage.textContent = "RECONNECTING...";
            if (connectedStatus) {
              connectedStatus.textContent = `Connection recovery in progress...`;
              connectedStatus.style.color = "#ff9900";
            }
          } catch (e) {
            console.warn(`[Connected] Error updating UI:`, e);
          }
          
          // Save the controller ID in session storage before navigation
          if (connectionId) {
            sessionStorage.setItem('synthConnectionId', connectionId);
          }
          
          // Navigate back to connecting page with reconnect flag
          setTimeout(() => {
            window.location.href = `/synthesis/connecting?reconnect=true&target=${connectionId}&attempt=${newAttempt}`;
          }, 2000);
          return;
        } else {
          // We've exhausted our recovery options or hit the retry limit
          console.error(`[Connected] Recovery failed - too many attempts (${navigationAttempts}) or no controller ID`);
          
          // Show a "refresh needed" message to the user
          try {
            const connectedMessage = document.querySelector('.connected-message');
            const connectedStatus = document.querySelector('.connected-status');
            if (connectedMessage) connectedMessage.textContent = "CONNECTION LOST";
            if (connectedStatus) {
              connectedStatus.textContent = "Please refresh page or re-initiate connection";
              connectedStatus.style.color = "#ff5555";
            }
          } catch (e) {
            console.warn(`[Connected] Error updating UI:`, e);
          }
        }
      }
      
      // Always ensure the connection ID is in the session storage
      if (connectionId) {
        sessionStorage.setItem('synthConnectionId', connectionId);
      }
      
      // CRITICAL: Ensure status always shows as connected
      console.log('[Connected onMount] Setting connected state in session storage');
      sessionStorage.setItem('dataChannelState', 'open');
      sessionStorage.setItem('connectionState', 'connected');
      
      // Force status update with explicit connection message - always use "Connected!"
      // even if refreshed, to maintain consistent UI state
      sessionStorage.setItem('statusMessage', "Connected!");
      
      // Also do a direct DOM update to force the status indicator
      // This is a backup in case reactive updates aren't working properly
      try {
        const statusElement = document.querySelector('.connection-state');
        if (statusElement) {
          statusElement.textContent = 'CONNECTED';
          statusElement.classList.add('connected');
          statusElement.classList.remove('connecting');
          console.log('[Connected onMount] Forced status element update');
        }
        
        // Simple session storage update for the connected state
        // We no longer need to manipulate the DOM directly as
        // the layout component will handle the status display based on route
        const connectedScript = `
          (function() {
            console.log('[Connected] Setting session storage for connected state');
            // Update session storage for connected state
            sessionStorage.setItem('dataChannelState', 'open');
            sessionStorage.setItem('connectionState', 'connected');
            sessionStorage.setItem('statusMessage', 'Connected!');
            
            // Ensure controller ID is available - attempt to get from multiple sources
            var storedConnectionId = sessionStorage.getItem('synthConnectionId');
            var scriptUrlParams = new URLSearchParams(window.location.search);
            var scriptUrlConnectionId = scriptUrlParams.get('ctrl');
            var scriptSynthId = sessionStorage.getItem('synthId');
          
            // If we have a controller ID from any source, ensure it's in session storage
            if (storedConnectionId) {
              console.log('[Connected script] Using stored controller ID: ' + storedConnectionId);
              // Already in session storage, nothing to do
            } else if (scriptUrlConnectionId) {
              console.log('[Connected script] Using URL controller ID: ' + scriptUrlConnectionId);
              storedConnectionId = scriptUrlConnectionId;
              sessionStorage.setItem('synthConnectionId', scriptUrlConnectionId);
            } else if (window.syntheticPeerConnection && window.syntheticDataChannel) {
              console.log('[Connected script] Connection exists but no ID, using fallback');
              storedConnectionId = 'unknown';
              sessionStorage.setItem('synthConnectionId', 'unknown');
            }
          
            // Update synth ID element in DOM if available
            if (scriptSynthId) {
              console.log('[Connected script] Found synth ID in session storage: ' + scriptSynthId);
              setTimeout(() => {
                const synthIdElements = document.querySelectorAll('.synth-id');
                if (synthIdElements.length > 0) {
                  synthIdElements.forEach(element => {
                    element.textContent = scriptSynthId;
                    console.log('[Connected script] Updated synth ID in DOM: ' + scriptSynthId);
                  });
                } else {
                  console.warn('[Connected script] No synth ID elements found in DOM');
                }
              }, 300);
            } else {
              console.warn('[Connected script] No synth ID found in session storage');
            }
            
            // Directly update the controller ID display in the DOM
            try {
              // Wait a bit for the DOM to settle
              setTimeout(() => {
                // Get all elements with the ctrl-id class
                const ctrlIdElements = document.querySelectorAll('.ctrl-id');
                
                if (ctrlIdElements.length > 0) {
                  console.log('[Connected script] Found ' + ctrlIdElements.length + ' controller ID elements');
                  ctrlIdElements.forEach(element => {
                    // Update class based on ID status
                    element.classList.remove('missing', 'unknown', 'valid');
                    
                    if (!storedConnectionId) {
                      element.classList.add('missing');
                      element.textContent = 'NONE!';
                    } else if (storedConnectionId === 'unknown') {
                      element.classList.add('unknown');
                      element.textContent = 'ID MISSING';
                    } else {
                      element.classList.add('valid');
                      element.textContent = storedConnectionId;
                    }
                    
                    console.log('[Connected script] Updated controller ID element to: ' + element.textContent);
                  });
                } else {
                  console.warn('[Connected script] No controller ID elements found in DOM');
                }
              }, 300);
            } catch (e) {
              console.error('[Connected script] Error updating controller ID in DOM:', e);
            }
          })();
        `;
        
        // Inject the script into the page
        const scriptElement = document.createElement('script');
        scriptElement.textContent = connectedScript;
        document.head.appendChild(scriptElement);
        console.log('[Connected onMount] Injected force connected script');
      } catch (e) {
        console.warn('[Connected onMount] Could not force status element update:', e);
      }
      
      console.log(`[Connected] Retrieved connection info: controller=${connectionId}, latency=${latency}ms`);
      
      // Make sure the connection ID is available globally
      if (browser && connectionId) {
        sessionStorage.setItem('synthConnectionId', connectionId);
      }
      
      // **** IMPROVED CONNECTION HANDLING ****
      // First, try retrieving the connection from global variables
      console.log("[Connected] Attempting to retrieve connection objects from window");
      let pcFromWindow = window.syntheticPeerConnection;
      let dcFromWindow = window.syntheticDataChannel;
      
      // Get the peer connection and data channel from window
      if (pcFromWindow) {
        peerConnection = pcFromWindow;
        console.log(`[Connected] Retrieved peer connection from window, state: ${peerConnection.connectionState}`);
        
        // Override potentially problematic RTCPeerConnection methods for stability
        // Save original methods
        const originalPcClose = peerConnection.close.bind(peerConnection);
        
        // Create a safer RTCPeerConnection with protective overrides
        peerConnection.close = function() {
          console.log(`[Protected PC] Close attempt detected - checking if it's user-initiated`);
          // We'll only allow close if it's explicitly called by our code
          // and not by internal WebRTC processes
          const isUserInitiated = new Error().stack?.includes('handleDeadConnection');
          if (isUserInitiated) {
            console.log(`[Protected PC] User-initiated close - allowing`);
            return originalPcClose();
          } else {
            console.log(`[Protected PC] Prevented automatic close during critical period`);
            // Don't actually close
            return;
          }
        };
        
        // Add connection state change handlers to ensure we catch all disconnections
        // But with improved stability during initial setup
        const safeStateTransitions = ["new", "connecting", "connected"];
        let initialSetupComplete = false;
        
        setTimeout(() => {
          initialSetupComplete = true;
          console.log(`[Connected] Initial setup phase complete, now monitoring all state transitions`);
        }, 5000); // 5 second grace period
        
        peerConnection.onconnectionstatechange = (e) => {
          const state = peerConnection?.connectionState || "unknown";
          console.log(`[Connected onconnectionstatechange] Connection state: ${state}`);
          
          // Update session storage with actual state
          if (browser && peerConnection) {
            sessionStorage.setItem('connectionState', state === 'connected' ? 'connected' : 'disconnected');
          }
          
          // During initial setup, ignore potentially problematic state transitions
          if (!initialSetupComplete && !safeStateTransitions.includes(state)) {
            console.log(`[Connected] Ignoring state '${state}' during initial setup period`);
            return;
          }
          
          // Check for disconnection - but only after initial setup
          if (initialSetupComplete && 
             (state === 'disconnected' || state === 'failed' || state === 'closed')) {
            console.warn(`[Connected onconnectionstatechange] WebRTC connection ${state}`);
            handleDeadConnection(state === 'disconnected'); // Use delay for 'disconnected' state
          }
        };
        
        peerConnection.oniceconnectionstatechange = (e) => {
          const state = peerConnection?.iceConnectionState || "unknown";
          console.log(`[Connected oniceconnectionstatechange] ICE state: ${state}`);
          
          // During initial setup, be more conservative about ICE state changes
          if (!initialSetupComplete && state === 'disconnected') {
            console.log(`[Connected] Ignoring ICE disconnected during initial setup period`);
            return;
          }
          
          // Check for failed ICE connection - this is the most reliable indicator of connectivity issues
          if (initialSetupComplete && state === 'failed') {
            console.warn(`[Connected oniceconnectionstatechange] ICE connection failed`);
            handleDeadConnection(false); // No delay for failed state
          } 
          else if (initialSetupComplete && state === 'disconnected') {
            console.warn(`[Connected oniceconnectionstatechange] ICE connection disconnected - allowing time for recovery`);
            // For disconnected state, wait to see if WebRTC can recover on its own
            handleDeadConnection(true); // Use delay for disconnected state
          }
        };
      } else {
        console.warn("[Connected] No peer connection available from window, will try to reconnect");
      }
      
      if (dcFromWindow) {
        dataChannel = dcFromWindow;
        console.log(`[Connected] Retrieved data channel from window, state: ${dataChannel.readyState}`);
        
        // Override potentially problematic data channel methods for stability
        // Save original methods
        const originalDcClose = dataChannel.close.bind(dataChannel);
        const originalDcSend = dataChannel.send.bind(dataChannel);
        
        // Create safer data channel with protective overrides
        dataChannel.close = function() {
          console.log(`[Protected DC] Close attempt detected - checking if it's user-initiated`);
          // We'll only allow close if it's explicitly called by our code
          const isUserInitiated = new Error().stack?.includes('handleDeadConnection');
          if (isUserInitiated) {
            console.log(`[Protected DC] User-initiated close - allowing`);
            return originalDcClose();
          } else {
            console.log(`[Protected DC] Prevented automatic close`);
            // Don't actually close
            return;
          }
        };
        
        // Create safer send method that won't throw during transitions
        dataChannel.send = function(data) {
          try {
            if (this.readyState === 'open') {
              return originalDcSend(data);
            } else {
              console.log(`[Protected DC] Blocked send during transition, DC state: ${this.readyState}`);
            }
          } catch (e) {
            console.warn(`[Protected DC] Error in protected send:`, e);
          }
        };
        
        // Add data channel state change handlers - only become active after setup period
        let initialDCSetupComplete = false;
        
        setTimeout(() => {
          initialDCSetupComplete = true;
          console.log(`[Connected] Data channel initial setup phase complete, enabling handlers`);
        }, 5000); // 5 second grace period
        
        dataChannel.onclose = (e) => {
          console.log(`[Connected onDataChannelClose] Data channel closed`);
          
          // Update session storage with actual state
          if (browser) {
            sessionStorage.setItem('dataChannelState', 'closed');
          }
          
          // Only trigger dead connection after initial setup period
          if (initialDCSetupComplete) {
            // This is a definite disconnection
            handleDeadConnection(false); // No delay for closed state
          } else {
            console.log(`[Connected onDataChannelClose] Ignoring close during setup period`);
          }
        };
        
        dataChannel.onerror = (e) => {
          console.warn(`[Connected onDataChannelError] Data channel error:`, e);
          
          // Check for User-Initiated Abort errors, which are normal during clean disconnect
          const isUserInitiatedAbort = 
            e.error && 
            e.error.message && 
            (e.error.message.includes("User-Initiated Abort") || 
             e.error.message.includes("Close called"));
              
          if (isUserInitiatedAbort) {
            console.log(`[Connected onDataChannelError] Normal close-related error, handling gracefully`);
            // This is part of normal disconnection - no need to update state, onclose will handle it
          } else if (initialDCSetupComplete) {
            // Only handle errors after setup period
            console.warn(`[Connected onDataChannelError] Real error, initiating disconnection`);
            handleDeadConnection(true); // Use delay for potential recovery
          } else {
            console.log(`[Connected onDataChannelError] Ignoring error during setup period`);
          }
        };
        
        // Set up data channel message handler
        dataChannel.onmessage = e => {
          const message = e.data;
          console.log(`[Connected] DC msg received: ${message}`);
          
          // Handle explicit disconnect message from controller
          if (message === 'ctrl:disconnect') {
            console.warn(`[Connected] Received explicit disconnect signal from controller`);
            
            // Handle graceful disconnection immediately (without delay)
            handleDeadConnection(false);
            return;
          }
          
          // Combined ping/pong system for both latency and verification
          if (message.startsWith('ping:')) {
            // Respond immediately with a pong containing the original timestamp
            const pingTimestamp = message.substring(5);
            dataChannel.send(`pong:${pingTimestamp}`);
            console.log(`[Connected] Responded to ping with pong:${pingTimestamp}`);
            
            // Also use this as verification that controller is active
            lastPongReceived = Date.now();
            
          } else if (message.startsWith('pong:')) {
            // Process pong for latency calculation and connection verification
            const pingTimestamp = parseInt(message.substring(5), 10);
            if (!isNaN(pingTimestamp)) {
              handlePong(pingTimestamp);
            }
          }
        };
        
        // Start connection monitoring only after setup is complete
        setTimeout(() => {
          if (dataChannel && dataChannel.readyState === 'open') {
            console.log(`[Connected] Starting connection monitoring after setup delay`);
            startConnectionMonitoring();
          } else {
            console.warn(`[Connected] Data channel not open after setup period, state: ${dataChannel?.readyState}`);
            // Still try to start monitoring, but with a warning
            startConnectionMonitoring();
          }
        }, 3000);
      } else {
        console.warn("[Connected] No data channel available from window, will need to reconnect");
      }
      
      // Initialize audio nodes
      if (audioCtx) {
        if (audioCtx.state === 'suspended') {
          console.warn("[Connected] Audio context is suspended, redirecting to root for user gesture");
          goto('/');
          return;
        }
        initAudio();
      } else {
        // No audio context? Redirect to root
        console.warn("[Connected] No audio context found in store, redirecting to root");
        goto('/');
        return;
      }
      
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
      
      // Set up time interval for updates - DO NOT CHECK CONNECTION STATE HERE
      // We're only updating the time display, NOT checking connection state
      // as that's too aggressive and could cause false disconnects
      timeInterval = window.setInterval(() => {
        currentTime = new Date().toISOString();
        
        // We intentionally avoid performing connection checks here
        // Connection state is tracked through WebRTC event handlers instead
      }, 1000);
    }
  });
  
  onDestroy(() => {
    cleanup();
  });
</script>

<svelte:head>
  <title>Connected Synthesizer</title>
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

<div class="synthesis-content">
  {#if audioCtx && audioState !== 'running'}
    <div class="audio-controls">
      <button 
        class="audio-resume-button"
        on:click={resumeAudioContext}
      >
        ACTIVATE AUDIO
      </button>
    </div>
  {/if}
  
  <!-- Minimal status display, most info is in the header -->
  <div class="connected-display">
    <div class="connected-icon">✓</div>
    <div class="connected-message">SYNTHESIS CONNECTED</div>
    <div class="connected-status">READY FOR CONTROLLER COMMANDS</div>
  </div>
</div>

<style>
  /* Synthesis content container */
  .synthesis-content {
    width: 100%;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
  }
  
  /* Audio controls */
  .audio-controls {
    padding: 16px;
    margin-bottom: 16px;
    text-align: center;
  }
  
  .audio-resume-button {
    padding: 12px 16px;
    background-color: rgba(80, 70, 180, 0.3);
    color: rgba(180, 170, 240, 0.95);
    border: 1px solid rgba(100, 90, 200, 0.3);
    border-radius: 4px;
    font-family: 'Fira Code', monospace;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: center;
  }
  
  .audio-resume-button:hover, .audio-resume-button:focus {
    background-color: rgba(90, 80, 200, 0.4);
    border-color: rgba(120, 110, 220, 0.4);
  }
  
  /* Connected display */
  .connected-display {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-top: 40px;
    padding: 32px;
    text-align: center;
  }
  
  .connected-icon {
    font-size: 64px;
    color: rgba(100, 240, 160, 0.95);
    background: rgba(80, 220, 120, 0.2);
    border-radius: 50%;
    width: 120px;
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;
    border: 2px solid rgba(100, 240, 160, 0.3);
  }
  
  .connected-message {
    font-size: 1.3rem;
    font-weight: 600;
    color: rgba(180, 240, 200, 0.95);
    font-family: 'Fira Code', monospace;
    letter-spacing: 1px;
  }
  
  .connected-status {
    font-size: 0.9rem;
    color: rgba(150, 180, 220, 0.9);
    margin-top: 8px;
    font-family: 'Fira Code', monospace;
  }
</style>