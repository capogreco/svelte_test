/**
 * Firebase WebRTC Signaling
 * Provides utilities for using Firebase as a signaling server for WebRTC
 */
import { ref, set, get, remove, onValue, off, push, onChildAdded } from 'firebase/database';
import type { Database } from 'firebase/database';

/**
 * Sets up the controller presence in Firebase
 * @param db - Firebase database instance
 * @param controllerId - The controller's unique ID
 * @returns A function to clean up the Firebase listeners
 */
export async function setupControllerPresence(db: Database, controllerId: string): Promise<() => void> {
  const controllerRef = ref(db, `activeControllers/${controllerId}`);
  const synthOffersRef = ref(db, `synthOffers/${controllerId}`);
  
  // Set controller as active
  await set(controllerRef, { active: true, timestamp: Date.now() });
  console.log(`[Firebase] Controller ${controllerId} announced as active`);
  
  // Register onDisconnect hooks to clean up when connection ends
  await onDisconnect(controllerRef).remove();
  await onDisconnect(synthOffersRef).remove();
  console.log(`[Firebase] Registered onDisconnect hooks for controller`);
  
  // Return a cleanup function
  return () => {
    console.log(`[Firebase] Removing controller ${controllerId} from database`);
    // Cancel the disconnect hooks first
    onDisconnect(controllerRef).cancel();
    onDisconnect(synthOffersRef).cancel();
    
    // Then remove the entries
    remove(controllerRef).catch(e => console.error("[Firebase] Error removing controller entry:", e));
    remove(synthOffersRef).catch(e => console.error("[Firebase] Error removing synth offers:", e));
  };
}

/**
 * Sets up a listener for synthesis client offers
 * @param db - Firebase database instance
 * @param ctrlId - The controller's unique ID
 * @param iceServers - Array of ICE servers for connection
 * @param setupFunc - Function to set up WebRTC when an offer is received
 * @returns A function to clean up the Firebase listeners
 */
export function listenForSynthesisOffers(
  db: Database, 
  ctrlId: string,
  iceServers: RTCIceServer[],
  setupFunc: (synthId: string, offer: string, ctrlId: string) => void
): () => void {
  const offersRef = ref(db, `synthOffers/${ctrlId}`);
  const dbListeners: (() => void)[] = [];
  
  const offerListener = onChildAdded(offersRef, (snapshot) => {
    const synthId = snapshot.key;
    const offerData = snapshot.val();
    
    if (synthId && offerData && offerData.offer) {
      console.log(`[Firebase] Received offer from synth ${synthId}`);
      setupFunc(synthId, offerData.offer, ctrlId);
    } else {
      console.warn(`[Firebase] Received incomplete offer data for ${synthId}`, offerData);
    }
  }, (error) => {
    console.error('[Firebase] Error listening for synth offers:', error);
  });
  
  dbListeners.push(() => off(offersRef, 'child_added', offerListener));
  console.log(`[Firebase] Listening for synth offers at ${offersRef.toString()}`);
  
  // Return cleanup function that unsubscribes all listeners
  return () => {
    console.log(`[Firebase] Unsubscribing from ${dbListeners.length} listeners`);
    dbListeners.forEach(unsubscribe => unsubscribe());
  };
}

/**
 * Creates an ICE candidate listener for a WebRTC connection
 * @param db - Firebase database instance
 * @param pc - RTCPeerConnection instance
 * @param ctrlId - The controller's unique ID
 * @param synthId - The synthesis client's unique ID
 * @returns A function to clean up the Firebase listeners
 */
export function listenForSynthICECandidates(
  db: Database,
  pc: RTCPeerConnection,
  ctrlId: string,
  synthId: string
): () => void {
  const iceRef = ref(db, `synthOffers/${ctrlId}/${synthId}/synthIce`);
  
  const iceListener = onChildAdded(iceRef, async (snap) => {
    const candidate = snap.val();
    if (candidate && candidate.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`[Firebase] Added ICE candidate for synth ${synthId}`);
      } catch (e) {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          // Ignore errors for established connections
        } else {
          console.error(`[Firebase] Error adding ICE candidate for synth ${synthId}:`, e);
        }
      }
    }
  }, (error) => {
    console.error(`[Firebase] Error listening for ICE candidates from synth ${synthId}:`, error);
  });
  
  return () => off(iceRef, 'child_added', iceListener);
}

/**
 * Sends a disconnect marker to a synthesis client
 * @param db - Firebase database instance
 * @param ctrlId - The controller's unique ID
 * @param synthId - The synthesis client's unique ID
 */
export async function sendDisconnectMarker(db: Database, ctrlId: string, synthId: string): Promise<void> {
  try {
    // Set the disconnect marker
    const disconnectRef = ref(db, `synthOffers/${ctrlId}/${synthId}/disconnected`);
    await set(disconnectRef, Date.now());
    console.log(`[Firebase] Set disconnect marker for synth ${synthId}`);
    
    // Remove the entry after a delay to allow the client to detect the marker
    setTimeout(() => {
      const synthOfferRef = ref(db, `synthOffers/${ctrlId}/${synthId}`);
      remove(synthOfferRef)
        .then(() => console.log(`[Firebase] Removed offer entry for synth ${synthId}`))
        .catch(err => console.error(`[Firebase] Error removing offer entry:`, err));
    }, 3000);
  } catch (e) {
    console.error(`[Firebase] Error setting disconnect marker for synth ${synthId}:`, e);
  }
}

/**
 * Checks if a synthesis client has a disconnect marker
 * @param db - Firebase database instance
 * @param ctrlId - The controller's unique ID
 * @param synthId - The synthesis client's unique ID
 * @returns True if a disconnect marker was found
 */
export async function checkForDisconnectMarker(db: Database, ctrlId: string, synthId: string): Promise<boolean> {
  try {
    const disconnectRef = ref(db, `synthOffers/${ctrlId}/${synthId}/disconnected`);
    const snapshot = await get(disconnectRef);
    
    if (snapshot.exists()) {
      console.warn(`[Firebase] Found disconnect marker from controller ${ctrlId}`);
      return true;
    }
    
    return false;
  } catch (e) {
    console.warn(`[Firebase] Error checking for disconnect marker:`, e);
    return false;
  }
}