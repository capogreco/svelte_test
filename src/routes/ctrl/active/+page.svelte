<script lang="ts">
  import { user, db } from '$lib/firebase';
  import { ref, set, get, remove, onValue, onChildAdded, off, push, onDisconnect } from 'firebase/database';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';

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
  $: ({ iceServers, error = null } = data);
  $: if (browser && !$user) goto('/ctrl');

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

<div class="container mx-auto p-4">
    <h1 class="text-3xl font-bold underline mb-4">ACTIVE Controller</h1>
    {#if ctrlId}
        <p class="text-sm text-gray-400 mb-4">Controller ID: 
          <span class="font-mono">{ctrlId}</span>
        </p>
    {:else if !error}
        <p class="preset-outline-warning">Initializing controller...</p>
    {/if}

    {#if error}
      <p class="p-3 rounded mb-4 preset-tonal-error">Error: {error}</p>
    {/if}

    <div class="my-4">
      <h2 class="text-xl font-semibold">
        Connection Status ({connectionStates.size} clients)
      </h2>
      {#if connectionStates.size === 0}
        <p class="preset-tonal-warning mt-2">
          ... waiting for synthesis clients to connect.
        </p>
      {:else}
        <ul class="list-none mt-2 space-y-2">
           {#each Array.from(connectionStates.entries()) as [synthId, state] (synthId)}
            <li class="p-3 border rounded shadow-sm {
              state.connectionState === 'connected' && state.dataChannelState === 'open' 
              ? 'preset-tonal-success' 
              : 'preset-tonal-error'
            }">
              <strong class="block mb-1">Synth ID:</strong> 
              <span class="font-mono text-xs break-all">{synthId}</span> 
              <br/>
              <div class="grid grid-cols-3 gap-2 mt-1 text-sm">
                  <span>
                    <strong>Conn:</strong> 
                    <span class="font-mono">{state.connectionState}</span>
                  </span>
                  <span>
                    <strong>ICE:</strong> 
                    <span class="font-mono">{state.iceConnectionState}</span>
                  </span>
                  <span>
                    <strong>Data:</strong>
                    <span class="font-mono">{state.dataChannelState}</span>
                  </span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="my-4 p-4 border rounded preset-tonal-primary">
        <h2 class="text-xl font-semibold">Manual Control</h2>
        <p class="text-sm mt-1">Click anywhere on the page background (outside this box) to send a broadcast message to all connected clients.</p>
    </div>
</div>
