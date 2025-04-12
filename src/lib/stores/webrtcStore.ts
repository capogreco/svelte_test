/**
 * WebRTC Store
 * A centralized store for managing WebRTC connection state
 */
import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';

// Define the state interface
export interface WebRTCState {
  peerConnection: RTCPeerConnection | null;
  dataChannel: RTCDataChannel | null;
  connectionId: string | null;
  synthId: string | null;
  statusMessage: string;
  connectionState: string;
  iceState: string;
  dataChannelState: string;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  reconnectAttempts: number;
  latency: number;
}

// Create the initial state
const initialState: WebRTCState = {
  peerConnection: null,
  dataChannel: null,
  connectionId: null,
  synthId: null,
  statusMessage: 'Initializing...',
  connectionState: '',
  iceState: '',
  dataChannelState: '',
  connected: false,
  connecting: false,
  reconnecting: false,
  reconnectAttempts: 0,
  latency: 0
};

// Create the store
function createWebRTCStore() {
  const { subscribe, update, set } = writable<WebRTCState>(initialState);

  // Update session storage whenever store changes
  const unsubscribe = subscribe(state => {
    if (!browser) return;
    
    if (state.statusMessage) {
      sessionStorage.setItem('statusMessage', state.statusMessage);
    }
    
    if (state.dataChannelState) {
      sessionStorage.setItem('dataChannelState', state.dataChannelState);
    }
    
    if (state.connectionId) {
      sessionStorage.setItem('synthConnectionId', state.connectionId);
    }
    
    if (state.synthId) {
      sessionStorage.setItem('synthId', state.synthId);
    }
    
    sessionStorage.setItem('reconnecting', state.reconnecting.toString());
    sessionStorage.setItem('reconnectAttempts', state.reconnectAttempts.toString());
    sessionStorage.setItem('connected', state.connected.toString());
    
    if (state.latency > 0) {
      sessionStorage.setItem('synthLatency', state.latency.toString());
    }
  });

  // Read from session storage when running in browser
  const initFromSessionStorage = () => {
    if (!browser) return;
    
    const statusMessage = sessionStorage.getItem('statusMessage');
    const dataChannelState = sessionStorage.getItem('dataChannelState');
    const connectionId = sessionStorage.getItem('synthConnectionId');
    const synthId = sessionStorage.getItem('synthId');
    const reconnecting = sessionStorage.getItem('reconnecting') === 'true';
    const reconnectAttempts = parseInt(sessionStorage.getItem('reconnectAttempts') || '0');
    const latency = parseInt(sessionStorage.getItem('synthLatency') || '0');
    
    update(state => ({
      ...state,
      statusMessage: statusMessage || state.statusMessage,
      dataChannelState: dataChannelState || state.dataChannelState,
      connectionId: connectionId || state.connectionId,
      synthId: synthId || state.synthId,
      reconnecting,
      reconnectAttempts,
      latency
    }));
  };

  // Store connection objects and update state
  const setConnection = (pc: RTCPeerConnection, dc: RTCDataChannel, ctrlId: string, synthId: string) => {
    update(state => ({
      ...state,
      peerConnection: pc,
      dataChannel: dc,
      connectionId: ctrlId,
      synthId,
      connecting: true
    }));
    
    // Store in global window for redundancy
    if (browser) {
      window.syntheticPeerConnection = pc;
      window.syntheticDataChannel = dc;
      window.synthControllerID = ctrlId;
    }
  };

  // Update connection status
  const updateStatus = (message: string) => {
    update(state => ({
      ...state,
      statusMessage: message
    }));
  };

  // Update connection state
  const updateConnectionState = (connectionState: string, iceState: string, dcState: string) => {
    const isConnected = 
      (connectionState === 'connected' || connectionState === 'completed') && 
      (dcState === 'open');
    
    update(state => ({
      ...state,
      connectionState,
      iceState,
      dataChannelState: dcState,
      connected: isConnected,
      connecting: !isConnected && (
        connectionState === 'connecting' || 
        connectionState === 'new' || 
        iceState === 'checking'
      )
    }));
  };

  // Update latency
  const updateLatency = (latency: number) => {
    update(state => ({
      ...state,
      latency
    }));
  };

  // Handle reconnection state
  const setReconnecting = (isReconnecting: boolean, attempts: number = 0) => {
    update(state => ({
      ...state,
      reconnecting: isReconnecting,
      reconnectAttempts: attempts,
      connected: isReconnecting ? false : state.connected
    }));
  };

  // Clear connection
  const clearConnection = () => {
    update(state => ({
      ...state,
      peerConnection: null,
      dataChannel: null,
      connected: false,
      connecting: false
    }));
    
    if (browser) {
      window.syntheticPeerConnection = null;
      window.syntheticDataChannel = null;
    }
  };

  // Initialize store from session storage if in browser
  if (browser) {
    initFromSessionStorage();
  }

  return {
    subscribe,
    setConnection,
    updateStatus,
    updateConnectionState,
    updateLatency,
    setReconnecting,
    clearConnection,
    reset: () => set(initialState)
  };
}

// Create and export the store
export const webrtcStore = createWebRTCStore();

// Create derived stores for specific state
export const connectionStatus = derived(
  webrtcStore,
  $webrtcStore => ({
    connected: $webrtcStore.connected,
    connecting: $webrtcStore.connecting,
    reconnecting: $webrtcStore.reconnecting,
    statusMessage: $webrtcStore.statusMessage
  })
);

export const connectionDetails = derived(
  webrtcStore,
  $webrtcStore => ({
    connectionId: $webrtcStore.connectionId,
    synthId: $webrtcStore.synthId,
    connectionState: $webrtcStore.connectionState,
    iceState: $webrtcStore.iceState,
    dataChannelState: $webrtcStore.dataChannelState,
    latency: $webrtcStore.latency
  })
);