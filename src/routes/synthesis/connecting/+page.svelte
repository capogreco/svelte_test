<script lang="ts">
  import { audioContext } from "$lib/stores/audioContext";
  import { onMount, onDestroy } from "svelte";
  import { db, user } from "$lib/firebase"; // user might not be needed if unauthenticated
  import { query, limitToFirst, ref, set, get, onValue, off, push, remove } from "firebase/database";
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';

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

  // --- Core Logic ---
  const findActiveController = async (): Promise<string | null> => {
    statusMessage = "Searching for an active controller...";
    console.log("[findActiveController] Searching...");
    const controllersRef = ref(db, `activeControllers`);
    const activeQuery = query(controllersRef, limitToFirst(1));

    try {
      const snapshot = await get(activeQuery);
      if (snapshot.exists()) {
        let foundCtrlId: string | null = null;
        snapshot.forEach(childSnap => {
          if (!foundCtrlId) {
            foundCtrlId = childSnap.key;
          }
        });
        if (foundCtrlId) {
            console.log(`[findActiveController] Found controller: ${foundCtrlId}`);
            statusMessage = `Found controller: ${foundCtrlId}...`;
            return foundCtrlId;
        }
      }
      console.log("[findActiveController] No active controllers found.");
      statusMessage = "No active controllers found. Waiting...";
      return null;
    } catch (err) {
        console.error("[findActiveController] Error querying controllers:", err);
        error = "Failed to search for controllers.";
        statusMessage = "Error searching for controllers.";
        return null;
    }
  };

  const setupWebRTCAndConnect = async (ctrlId: string, currentSynthId: string) => {
    if (!iceServers || iceServers.length === 0) {
        console.error("[setupWebRTCAndConnect] No ICE servers configured.");
        error = "ICE server configuration missing.";
        statusMessage = "Configuration Error.";
        return;
    }
    targetCtrlId = ctrlId;
    console.log(`[setupWebRTCAndConnect] Setting up WebRTC for ctrlId: ${ctrlId}, synthId: ${currentSynthId}`);
    statusMessage = `Connecting to controller ${ctrlId?.substring(0, 8)}...`;

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
        statusMessage = `ICE State: ${pc.iceConnectionState}`; // Removed optional chaining
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
            console.error(`[oniceconnectionstatechange] ICE connection failed/closed.`);
            statusMessage = `Connection Failed/Closed (${pc.iceConnectionState})`;
        }
    };
    
    pc.onconnectionstatechange = () => {
        console.log(`[onconnectionstatechange] Connection state: ${pc.connectionState}`);
        statusMessage = `Connection State: ${pc.connectionState}`;
         if (pc.connectionState === 'connected') {
            statusMessage = "Connected!";
        }
    };

    const dc = pc.createDataChannel("synthData");
    dataChannel = dc;
    console.log(`[setupWebRTCAndConnect] Data channel created by synth.`);
    
    dc.onopen = () => {
        console.log(`[onDataChannelOpen] DC opened for synth ${currentSynthId}`);
        statusMessage = "Data Channel Open";
        dc.send(`Hello Ctrl ${ctrlId?.substring(0,4)}... from Synth ${currentSynthId?.substring(0,4)}...`);
    };
    dc.onmessage = e => {
        console.log(`[onDataChannelMessage] DC msg received: ${e.data}`);
    };
    dc.onclose = () => {
        console.log(`[onDataChannelClose] DC closed for synth ${currentSynthId}`);
        statusMessage = "Data Channel Closed";
    };
    dc.onerror = e => {
        console.error(`[onDataChannelError] DC error for synth ${currentSynthId}:`, e);
        statusMessage = "Data Channel Error";
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
            statusMessage = "~ offer sent, waiting for answer ~";
        } catch (writeError) {
            console.error(`[setupWebRTCAndConnect] FIREBASE WRITE ERROR sending offer:`, writeError);
            error = "Failed to send offer to controller.";
            statusMessage = "Error sending offer.";
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
                    statusMessage = "Answer received, connecting...";
                    addControllerIceListener(pc, ctrlId, currentSynthId);
                } catch (err) {
                    console.error(`[answerListener] Error setting remote description (answer):`, err);
                    error = "Failed to process controller's answer.";
                    statusMessage = "Error processing answer.";
                }
            } else if (answerSdp && pc.signalingState !== 'have-local-offer') {
                 console.warn(`[answerListener] Received answer but signaling state is unexpected: ${pc.signalingState}`);
            }
        }, (err) => {
            console.error(`[answerListener] Firebase error listening for answer:`, err);
            error = "Error receiving answer from controller.";
            statusMessage = "Error receiving answer.";
        });
        dbListeners.push(() => off(answerRef, 'value', answerListener));

    } catch (err) {
        console.error(`[setupWebRTCAndConnect] Error during offer/answer process:`, err);
        error = "Failed to initiate connection.";
        statusMessage = "Connection Initiation Failed.";
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
        statusMessage = "Error receiving connection details.";
    });
    dbListeners.push(() => off(iceRef, 'value', iceListener));
  };

  // --- Initialization and Cleanup ---
  const startSynthesisClient = async () => {
    if (!browser) {
        console.log("[startSynthesisClient] Not in browser environment.");
        return;
    }
    if (a_cxt) console.log(`[startSynthesisClient] AC state: ${a_cxt.state}`);

    // Generate ID using Firebase Push Key
    synthId = push(ref(db, 'synthOffers')).key;
    if (!synthId) {
        console.error("[startSynthesisClient] Failed to generate Firebase Push ID for synth.");
        error = "Failed to generate synth ID.";
        statusMessage = "Initialization Error.";
        return;
    }
    console.log(`[startSynthesisClient] Synth ID: ${synthId}`);
    statusMessage = `Synth ID: ${synthId.substring(0, 8)}...`;

    const foundCtrlId = await findActiveController();

    if (foundCtrlId) {
      setupWebRTCAndConnect(foundCtrlId, synthId);
    } else {
      console.log("[startSynthesisClient] No controller found initially. Implement waiting/retry logic if needed.");
      statusMessage = "Waiting for a controller to become active...";
    }
  };

  const cleanup = () => {
    console.log('[cleanup] Cleaning up Synth client.');
    console.log(`[cleanup] Unsubscribing from ${dbListeners.length} Firebase listeners.`);
     dbListeners.forEach(unsubscribe => {
      try { unsubscribe(); } catch (e) { console.warn("[cleanup] Error during listener unsubscribe:", e); }
    });
    dbListeners = [];

    if (peerConnection) {
        console.log(`[cleanup] Closing PeerConnection.`);
        try { dataChannel?.close(); } catch (e) { console.warn(`[cleanup] Error closing DC:`, e); }
        try { peerConnection.close(); } catch (e) { console.warn(`[cleanup] Error closing PC:`, e); }
        peerConnection = null;
        dataChannel = null;
    }

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
    statusMessage = "Connection closed."; // Set final status
    // Optional: Navigate away
    // goto('/synthesis');
  };

  // --- Svelte Lifecycle ---
  onMount(() => {
    startSynthesisClient().catch(err => {
        console.error("Error starting synth client:", err);
        error = "Failed to start synthesis client.";
        statusMessage = "Initialization Error.";
    });

    return () => {
        cleanup();
    };
  });

</script>

<svelte:head>
    <title>Connecting Synth...</title>
</svelte:head>

<main class="flex flex-col items-center justify-center min-h-screen p-4 text-center">
    <h1 class="text-3xl font-bold underline mb-6">CONNECTING SYNTHESIS CLIENT</h1>
    {#if error}
        <p class="rounded mb-4 preset-tonal-error">Error: {error}</p>
    {/if}
    <p class="text-lg mb-2">Status:</p>
    <p class="text-xl font-mono p-3 rounded border min-w-[300px] preset-tonal-tertiary">{statusMessage}</p>

    {#if synthId}
         <p class="text-sm text-gray-400 mt-4">Synth ID: <span class="font-mono">{synthId}</span></p>
    {/if}
    {#if targetCtrlId}
         <p class="text-sm text-gray-400 mt-1">Target Ctrl ID: <span class="font-mono">{targetCtrlId}</span></p>
    {/if}
</main>
