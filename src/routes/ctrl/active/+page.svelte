<script lang="ts">
  import { user, db } from '$lib/firebase';
  import { ref, set, get, remove, onValue, onChildAdded, off, push, onDisconnect } from 'firebase/database';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { activeControllerId } from '$lib/stores/controllerStore';

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

  // --- Props and Reactive Statements ---
  export let data: PgData;
  let error: string | Error | null = null;
  let currentTime = new Date().toISOString();
  let lastBroadcastTime: number | null = null;
  let signalActive = false;
  let signalTimeout: number;
  $: ({ iceServers, error = null } = data);
  $: if (browser && !$user) goto('/ctrl');
  
  // Update timestamp regularly
  let timeInterval: number;
  onMount(() => {
    if (browser) {
      timeInterval = window.setInterval(() => {
        currentTime = new Date().toISOString();
        
        // Check if signal should be active based on last broadcast time
        if (lastBroadcastTime) {
          const timeSinceBroadcast = Date.now() - lastBroadcastTime;
          signalActive = timeSinceBroadcast < 2000; // Active for 2 seconds after broadcast
        }
      }, 1000);
    }
  });
  
  onDestroy(() => {
    if (browser && timeInterval) {
      clearInterval(timeInterval);
    }
    if (browser && signalTimeout) {
      clearTimeout(signalTimeout);
    }
  });

  // --- State Management ---
  let connectionStates = new Map<string, {
    pc: RTCPeerConnection | null;
    dc: RTCDataChannel | null;
    connectionState: RTCPeerConnectionState | string;
    iceConnectionState: RTCIceConnectionState | string;
    dataChannelState: RTCDataChannelState | string;
    synthId: string;
  }>();

  let ctrlId: string | null = null;
  let dbListeners: (() => void)[] = [];

  // --- Helper Functions ---
  const updateConnectionState = (synthId: string, updates: Partial<typeof connectionStates extends Map<string, infer V> ? V : never>) => {
    const currentState = connectionStates.get(synthId);
    if (currentState) {
      connectionStates.set(synthId, { ...currentState, ...updates });
      connectionStates = connectionStates; // Trigger reactivity
    } else {
      console.warn(`[updateConnectionState] No state found for synthId: ${synthId}`);
    }
  };

  // --- WebRTC Setup ---
  const setupPeerConnection = (currentIceServers: IceSvr[], currentCtrlId: string, synthId: string) => {
    console.log(`[setupPeerConnection] Setting up for synth: ${synthId}`);
    const pc = new RTCPeerConnection({ iceServers: currentIceServers });

    connectionStates.set(synthId, {
      pc: pc,
      dc: null,
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      dataChannelState: 'initializing',
      synthId: synthId,
    });
    connectionStates = connectionStates;

    pc.onconnectionstatechange = e => {
      console.log(`[onconnectionstatechange ${synthId}] Connection state: ${pc.connectionState}`);
      updateConnectionState(synthId, { connectionState: pc.connectionState });
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        console.error(`[onconnectionstatechange ${synthId}] WebRTC connection failure/closed.`);
      }
    };

    pc.oniceconnectionstatechange = e => {
      console.log(`[oniceconnectionstatechange ${synthId}] ICE state: ${pc.iceConnectionState}`);
      updateConnectionState(synthId, { iceConnectionState: pc.iceConnectionState });
       if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.error(`[oniceconnectionstatechange ${synthId}] ICE connection state failed/disconnected.`);
      }
    };

    pc.onicecandidate = e => {
      if (e.candidate) {
        console.log(`[onicecandidate ${synthId}] Sending ICE candidate.`);
        set(ref(db, `synthOffers/${currentCtrlId}/${synthId}/ctrlIce`), e.candidate.toJSON())
          .catch(err => console.error(`[onicecandidate ${synthId}] Error sending ICE candidate:`, err));
      } else {
        console.log(`[onicecandidate ${synthId}] All ICE candidates sent.`);
      }
    };

    pc.ondatachannel = (event) => {
        console.log(`[ondatachannel ${synthId}] Received data channel!`);
        const dc = event.channel;
        setupDataChannel(dc, synthId);
    };

    const setupDataChannel = (dataChannel: RTCDataChannel, targetSynthId: string) => {
        console.log(`[setupDataChannel ${targetSynthId}] Setting up handlers for DC label: ${dataChannel.label}`);
        updateConnectionState(targetSynthId, { dc: dataChannel, dataChannelState: dataChannel.readyState });

        dataChannel.onopen = () => {
            console.log(`[onDataChannelOpen ${targetSynthId}] DC opened`);
            updateConnectionState(targetSynthId, { dataChannelState: dataChannel.readyState });
            dataChannel.send(`Hello Synth ${targetSynthId} from Ctrl ${currentCtrlId}`);
        };
        dataChannel.onmessage = e => console.log(`[onDataChannelMessage ${targetSynthId}] DC msg: ${e.data}`);
        dataChannel.onclose = () => {
            console.log(`[onDataChannelClose ${targetSynthId}] DC closed`);
            updateConnectionState(targetSynthId, { dataChannelState: dataChannel.readyState });
        };
        dataChannel.onerror = e => {
            console.error(`[onDataChannelError ${targetSynthId}] DC err:`, e);
            updateConnectionState(targetSynthId, { dataChannelState: 'error' });
        };
    };

    return { pc };
  };

  // --- Firebase Signaling Logic (Synth Initiates Connection) ---
  // --- Firebase Signaling Logic (Synth Initiates Connection) ---
const announcePresence = async (currentCtrlId: string) => {
  const controllerRef = ref(db, `activeControllers/${currentCtrlId}`);
  const synthOffersRef = ref(db, `synthOffers/${currentCtrlId}`); // Ref for the offers node

  try {
    // Set initial presence data
    await set(controllerRef, { active: true, timestamp: Date.now() });
    console.log(`[announcePresence] Controller ${currentCtrlId} announced.`);

    // --- Register onDisconnect hooks ---
    // Remove the controller's entry if disconnected
    await onDisconnect(controllerRef).remove();
    console.log(`[announcePresence] Registered onDisconnect hook to remove active controller entry.`);

    // Also remove the entire node for offers directed at this controller
    await onDisconnect(synthOffersRef).remove();
    console.log(`[announcePresence] Registered onDisconnect hook to remove synth offers node.`);
    // --- End of onDisconnect hooks ---

  } catch (e) {
    console.error('[announcePresence] Error announcing presence or setting onDisconnect:', e);
    // If setting presence fails, we don't want the disconnect hooks lingering,
    // but Firebase usually handles this. If setting onDisconnect fails, log it.
    throw e; // Re-throw to indicate failure in init
  }
};

  const handleSynthOffer = async (synthId: string, offerData: any, currentCtrlId: string) => {
      if (!offerData || typeof offerData.sdp !== 'string') {
          console.error(`[handleSynthOffer ${synthId}] Invalid offer data received:`, offerData);
          return;
      }
      console.log(`[handleSynthOffer ${synthId}] Received offer.`);

      if (connectionStates.has(synthId)) {
          console.warn(`[handleSynthOffer ${synthId}] Connection already exists or is in progress. Ignoring new offer.`);
          return;
      }

      try {
          const { pc } = setupPeerConnection(iceServers, currentCtrlId, synthId);

          await pc.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });
          console.log(`[handleSynthOffer ${synthId}] Remote description (offer) set.`);

          const answer = await pc.createAnswer();
          console.log(`[handleSynthOffer ${synthId}] Answer created.`);

          await pc.setLocalDescription(answer);
          console.log(`[handleSynthOffer ${synthId}] Local description (answer) set.`);

          // Use await here to catch potential permission errors
          await set(ref(db, `synthOffers/${currentCtrlId}/${synthId}/answer`), answer.sdp);
          console.log(`[handleSynthOffer ${synthId}] Answer sent to Firebase.`);

          addSynthIceListener(pc, currentCtrlId, synthId);

      } catch (e) {
          console.error(`[handleSynthOffer ${synthId}] Error handling offer:`, e);
          connectionStates.delete(synthId);
          connectionStates = connectionStates;
      }
  };

  const addSynthIceListener = (pc: RTCPeerConnection, currentCtrlId: string, synthId: string) => {
    const iceRef = ref(db, `synthOffers/${currentCtrlId}/${synthId}/synthIce`);
    const listener = onChildAdded(iceRef, async snap => {
      const candidate = snap.val();
      if (candidate && candidate.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log(`[addSynthIceListener ${synthId}] Added ICE candidate:`, candidate.sdpMid || candidate.sdpMLineIndex);
        } catch (e) {
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
             // console.warn(`[addSynthIceListener ${synthId}] Ignoring error adding ICE candidate in established state: ${e.message}`);
          } else if (e instanceof DOMException && e.message.includes("Error processing ICE candidate")) {
             // console.warn(`[addSynthIceListener ${synthId}] Ignoring known ICE processing error: ${e.message}`);
          } else {
             console.error(`[addSynthIceListener ${synthId}] Error adding ICE candidate:`, e);
          }
        }
      } else {
        console.warn(`[addSynthIceListener ${synthId}] Received invalid ICE candidate data:`, candidate);
      }
    }, error => {
        console.error(`[addSynthIceListener ${synthId}] Firebase listener error on synthIce:`, error);
    });

    dbListeners.push(() => off(iceRef, 'child_added', listener));
    console.log(`[addSynthIceListener ${synthId}] Listening for ICE candidates at ${iceRef.toString()}`);
  };

  // --- Broadcasting ---
  const broadcastMessage = (message: string) => {
    console.log(`[broadcastMessage] Attempting to send: "${message}"`);
    let sentCount = 0;
    
    // Set the last broadcast time
    lastBroadcastTime = Date.now();
    signalActive = true;
    
    // Activate signal indicator
    if (browser && signalTimeout) {
      clearTimeout(signalTimeout);
    }
    signalTimeout = window.setTimeout(() => {
      signalActive = false;
    }, 2000);
    
    connectionStates.forEach((state, synthId) => {
      if (state.dc && state.dc.readyState === 'open') {
        try {
            state.dc.send(message);
            sentCount++;
        } catch (error) {
            console.error(`  - Failed to send to ${synthId}:`, error);
        }
      }
    });
    
    console.log(`[broadcastMessage] Sent to ${sentCount} / ${connectionStates.size} connected clients.`);
  };

  const handleBodyClick = () => {
      broadcastMessage(`ctrl_event:click_${Date.now()}`);
  };

  // --- Initialization and Cleanup ---
  const initController = async () => {
    if (!browser || !$user) {
        console.log("[initController] Not in browser or not logged in. Aborting.");
        goto('/ctrl');
        return null;
    }
    if (!iceServers || iceServers.length === 0) {
        console.error("[initController] No ICE servers provided. Aborting.");
        error = "Failed to load ICE server configuration.";
        return null;
    }

    // Generate ID using Firebase Push Key
    ctrlId = push(ref(db, 'activeControllers')).key;
    if (!ctrlId) {
        console.error("[initController] Failed to generate Firebase Push ID.");
        error = "Failed to generate controller ID.";
        return null;
    }
    console.log(`[initController] Controller ID: ${ctrlId}`);
    
    // Update the store with the controller ID for the layout to use
    activeControllerId.set(ctrlId);

    await announcePresence(ctrlId);

    const offersRef = ref(db, `synthOffers/${ctrlId}`);
    const offerListener = onChildAdded(offersRef, (snapshot) => {
        const synthId = snapshot.key;
        const offerData = snapshot.val();
        if (synthId && offerData && offerData.offer) {
            handleSynthOffer(synthId, { sdp: offerData.offer }, ctrlId!);
        } else {
             console.warn(`[initController] Received incomplete/malformed offer data for key: ${synthId}`, offerData);
        }
    }, (error) => {
        console.error('[initController] Firebase error listening for synth offers:', error);
        error = new Error("Error connecting to signaling server.");
    });

    dbListeners.push(() => off(offersRef, 'child_added', offerListener));
    console.log(`[initController] Listening for synth offers at ${offersRef.toString()}`);

    return ctrlId;
  };

  const cleanup = () => {
    console.log('[cleanup] Cleaning up Ctrl client.');
    console.log(`[cleanup] Unsubscribing from ${dbListeners.length} Firebase listeners.`);
    dbListeners.forEach(unsubscribe => {
      try { unsubscribe(); } catch (e) { console.warn("[cleanup] Error during listener unsubscribe:", e); }
    });
    dbListeners = [];

    console.log(`[cleanup] Closing ${connectionStates.size} WebRTC connections.`);
    connectionStates.forEach((state, synthId) => {
      console.log(`[cleanup] Closing connection for ${synthId}`);
      try { state.dc?.close(); } catch (e) { console.warn(`[cleanup] Error closing DC for ${synthId}:`, e); }
      try { state.pc?.close(); } catch (e) { console.warn(`[cleanup] Error closing PC for ${synthId}:`, e); }
    });
    connectionStates.clear();
    connectionStates = connectionStates;

    if (ctrlId) {
        console.log(`[cleanup] Removing database entries for controller ${ctrlId}`);
        const controllerRef = ref(db, `activeControllers/${ctrlId}`);
        const synthOffersRef = ref(db, `synthOffers/${ctrlId}`);

        // Cancel the disconnect hooks first
        onDisconnect(controllerRef).cancel(); 
        onDisconnect(synthOffersRef).cancel();

        remove(controllerRef).catch(e => console.error("[cleanup] Error removing active controller entry:", e));
        remove(synthOffersRef).catch(e => console.error("[cleanup] Error removing synth offers node:", e));
        
        // Reset the controller ID in the store
        activeControllerId.set(null);
    } else {
        console.log("[cleanup] No controller ID, skipping DB removal.");
    }
    ctrlId = null;
    console.log("[cleanup] Cleanup complete.");
  };

  // --- Svelte Lifecycle Hooks ---
  onMount(() => {
    initController().then(id => {
        if (id) {
            console.log("Controller initialized successfully.");
            document.body.addEventListener('click', handleBodyClick);
        } else {
            console.error("Controller initialization failed.");
        }
    }).catch(err => {
        console.error("Error during controller initialization:", err);
        error = "An unexpected error occurred during setup.";
    });

    return () => {
        document.body.removeEventListener('click', handleBodyClick);
        cleanup();
    };
  });

</script>

<svelte:head>
    <title>Active Controller</title>
</svelte:head>

<div class="h-screen w-screen flex flex-col justify-between p-0">
  <!-- Floating glass-style main UI panel -->
  <div class="main-ui-panel">
    
    {#if error}
      <div class="error-message">
        <span>ERROR: {error}</span>
      </div>
    {/if}
    
    <div class="spacer"></div>

    <!-- Unified bottom control panel -->
    <div class="bottom-controls">
      <!-- Left side - Controller ID -->
      <div class="control-section">
        {#if ctrlId}
          <div class="terminal-item id-item">
            <span class="item-label">ID:</span>
            <span class="item-value">{ctrlId}</span>
          </div>
        {:else}
          <div class="terminal-item initializing">
            <span>INITIALIZING...</span>
          </div>
        {/if}
      </div>
      
      <!-- Center - Connection counts -->
      <div class="control-section counts-section">
        {#if true}
          {@const activeConnections = Array.from(connectionStates.values()).filter(state => 
              state.connectionState === 'connected' && state.dataChannelState === 'open'
            ).length}
          {@const pendingConnections = Array.from(connectionStates.values()).filter(state => 
              state.connectionState !== 'connected' || state.dataChannelState !== 'open'
            ).length}
            
          <div class="terminal-item">
            <span class="item-label">ACTIVE:</span>
            <span class="item-value">{activeConnections}</span>
          </div>
          
          {#if pendingConnections > 0}
            <div class="terminal-item">
              <span class="item-label">PENDING:</span>
              <span class="item-value">{pendingConnections}</span>
            </div>
          {/if}
        {/if}
      </div>
      
      <!-- Right side - Broadcast button -->
      <div class="control-section broadcast-section">
        <button 
          class="broadcast-button {signalActive ? 'active' : ''}" 
          on:click={() => broadcastMessage(`ctrl_event:manual_broadcast_${Date.now()}`)}
        >
          <span class="broadcast-indicator"></span>
          <span class="broadcast-msg">BROADCAST</span>
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  /* Connection list styling for background with better contrast */
  .terminal-background {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    padding: 20px;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.4;
    color: rgba(210, 230, 210, 0.85);
    overflow: hidden;
    z-index: -1;
    pointer-events: none;
    background-color: rgba(10, 15, 20, 0.05);
    
    /* Create a grid for connections that wraps when needed */
    display: flex;
    flex-direction: column;
    flex-wrap: wrap;
    gap: 5px;
    align-content: flex-start;
    max-height: calc(100vh - 100px);
  }
  
  .terminal-header {
    margin-bottom: 12px;
    color: rgba(80, 200, 220, 0.9);
    font-weight: bold;
  }
  
  .terminal-line {
    display: flex;
    align-items: center;
    gap: 12px;
    white-space: nowrap;
    opacity: 0.85;
    margin-bottom: 2px;
    min-width: 460px;
    width: fit-content;
    margin-right: 20px;
    font-family: 'Courier New', monospace;
  }
  
  /* Make dynamic height adjustments based on connection count */
  :global(.terminal-background:has(.terminal-line:nth-child(n+20))) {
    font-size: 12px;
    line-height: 1.3;
  }
  
  :global(.terminal-background:has(.terminal-line:nth-child(n+50))) {
    font-size: 11px;
    line-height: 1.2;
  }
  
  :global(.terminal-background:has(.terminal-line:nth-child(n+100))) {
    font-size: 10px;
    line-height: 1.1;
  }
  
  .connection-status-icon {
    width: 15px;
    display: inline-block;
    font-size: 0.8em;
  }
  
  .terminal-success .connection-status-icon {
    color: rgba(80, 220, 120, 0.9);
  }
  
  .terminal-error .connection-status-icon {
    color: rgba(220, 80, 80, 0.9);
  }
  
  .terminal-cmd {
    color: rgba(220, 220, 220, 0.9);
  }
  
  .waiting-message {
    color: rgba(180, 180, 180, 0.8);
    font-style: italic;
    animation: pulse 2s infinite;
  }
  
  .terminal-system {
    color: rgba(100, 210, 220, 0.95);
    font-weight: bold;
  }
  
  .terminal-id {
    color: rgba(250, 230, 120, 0.95);
    width: 230px;
    display: inline-block;
    overflow: visible;
    white-space: nowrap;
    font-size: 0.9em;
    font-weight: 500;
  }
  
  .terminal-status {
    color: rgba(200, 210, 200, 0.85);
    margin-right: 15px;
    min-width: 65px;
    display: inline-block;
  }
  
  .terminal-success .terminal-status {
    color: rgba(120, 230, 120, 0.9);
  }
  
  .terminal-error .terminal-status {
    color: rgba(255, 150, 150, 0.9);
  }
  
  /* Main UI elements */
  .main-ui-panel {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 16px;
    font-family: 'Inter', 'Roboto', sans-serif;
  }
  
  /* Top section styling */
  .controller-id {
    display: flex;
    align-items: center;
    gap: 10px;
    background: rgba(40, 50, 60, 0.7);
    border-radius: 4px;
    padding: 8px 12px;
    margin-bottom: 16px;
    width: fit-content;
  }
  
  .id-label {
    font-size: 0.8rem;
    color: rgba(180, 200, 220, 0.9);
    font-weight: 600;
  }
  
  .id-value {
    font-family: 'Courier New', monospace;
    font-size: 0.85rem;
    color: rgba(250, 230, 120, 0.95);
    padding-left: 4px;
  }
  
  .initializing {
    display: flex;
    align-items: center;
    gap: 8px;
    color: rgba(250, 180, 80, 0.95);
    font-size: 0.9rem;
    margin-bottom: 16px;
    animation: pulse 1.5s infinite;
    font-weight: bold;
  }
  
  .error-message {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(80, 20, 20, 0.7);
    color: rgba(255, 150, 150, 0.95);
    padding: 8px 12px;
    border-radius: 4px;
    margin-bottom: 16px;
    font-weight: bold;
  }
  
  
  /* Status bar styling */
  .status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(40, 50, 60, 0.7);
    border-radius: 4px;
    padding: 10px 14px;
    margin-bottom: 16px;
  }
  
  .status-indicator {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  
  
  .status-label {
    font-size: 0.75rem;
    color: rgba(180, 200, 220, 0.9);
    font-weight: 600;
  }
  
  .status-counters {
    display: flex;
    gap: 20px;
  }
  
  .status-counter {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  
  .counter-number {
    font-size: 1.4rem;
    font-weight: 600;
    color: rgba(120, 210, 250, 0.95);
  }
  
  /* Spacer to push content to bottom */
  .spacer {
    flex-grow: 1;
  }
  
  /* Bottom unified control panel */
  .bottom-controls {
    display: flex;
    justify-content: space-between;
    background: rgba(30, 40, 50, 0.8);
    border-top: 1px solid rgba(70, 100, 130, 0.4);
    padding: 12px 18px;
    margin-top: auto;
    width: 100%;
  }
  
  .control-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  
  .terminal-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    color: rgba(200, 220, 200, 0.9);
  }
  
  .counts-section {
    display: flex;
    flex-direction: row;
    gap: 20px;
    justify-content: center;
  }
  
  .broadcast-section {
    display: flex;
    justify-content: flex-end;
  }
  
  .broadcast-button {
    display: flex;
    align-items: center;
    gap: 8px;
    color: rgba(180, 240, 200, 0.95);
    font-weight: 600;
    font-size: 0.9rem;
    border: 1px solid rgba(120, 180, 160, 0.3);
    padding: 6px 14px;
    border-radius: 4px;
    background-color: rgba(40, 80, 60, 0.3);
    letter-spacing: 0.5px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  
  .broadcast-button:hover {
    background-color: rgba(50, 100, 80, 0.5);
    border-color: rgba(120, 220, 180, 0.5);
    box-shadow: 0 0 10px rgba(60, 220, 160, 0.2);
  }
  
  .broadcast-button:active {
    background-color: rgba(60, 120, 100, 0.6);
    transform: scale(0.98);
  }
  
  .broadcast-button.active {
    background-color: rgba(60, 140, 100, 0.6);
    border-color: rgba(120, 240, 180, 0.6);
    box-shadow: 0 0 15px rgba(60, 240, 160, 0.3);
  }
  
  .broadcast-indicator {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background-color: rgba(120, 180, 160, 0.5);
    transition: all 0.2s ease;
  }
  
  .broadcast-button.active .broadcast-indicator {
    background-color: rgba(80, 240, 160, 0.9);
    box-shadow: 0 0 8px rgba(80, 240, 160, 0.8);
  }
  
  .broadcast-msg {
    color: inherit;
    letter-spacing: 0.5px;
  }
  
  .item-label {
    color: rgba(150, 180, 200, 0.85);
    font-weight: 600;
  }
  
  .item-value {
    color: rgba(180, 240, 200, 0.95);
    font-weight: 500;
  }
  
  /* Special styling for the ID display */
  .id-item {
    max-width: 300px;
    overflow: hidden;
  }
  
  .id-item .item-value {
    font-size: 0.75rem;
    font-family: 'Courier New', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(250, 230, 120, 0.95);
  }
  
  
  /* Animations */
  @keyframes pulse {
    0% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
    100% {
      opacity: 0.5;
    }
  }
  
</style>

<!-- Command line style connection list -->
<div class="terminal-background" aria-hidden="true">
  {#if connectionStates.size === 0}
    <div class="terminal-header">
      <!-- Terminal header showing system status -->
      <span class="terminal-line">
        <span class="terminal-system">DISTRIBUTED_SYNTH_NETWORK (v0.1) - {currentTime}</span>
      </span>
      <span class="terminal-line">
        <span class="terminal-system">CTRL [{ctrlId || 'initializing...'}]</span>
      </span>
      <span class="terminal-line">
        <span class="terminal-system">─────────────────────────────────────────────</span>
      </span>
    </div>
    <div class="terminal-line">
      <span class="terminal-cmd waiting-message">waiting for synth connections...</span>
    </div>
  {:else}
    <div class="terminal-header">
      <!-- Terminal header showing system status -->
      <span class="terminal-line">
        <span class="terminal-system">DISTRIBUTED_SYNTH_NETWORK (v0.1) - {currentTime}</span>
      </span>
      <span class="terminal-line">
        <span class="terminal-system">CTRL [{ctrlId}]</span>
      </span>
      <span class="terminal-line">
        <span class="terminal-system">─────────────────────────────────────────────</span>
      </span>
    </div>
    
    <!-- Connection list styled as terminal output -->
    {#each Array.from(connectionStates.entries()) as [synthId, state] (synthId)}
      {#if true}
        {@const isConnected = state.connectionState === 'connected' && state.dataChannelState === 'open'}
        <div class="terminal-line {isConnected ? 'terminal-success' : 'terminal-error'}">
          <span class="connection-status-icon">{isConnected ? '●' : '○'}</span>
          <span class="terminal-id">{synthId}</span>
          <span class="terminal-status">{state.connectionState}</span>
          <span class="terminal-status">{state.dataChannelState}</span>
        </div>
      {/if}
    {/each}
  {/if}
</div>
