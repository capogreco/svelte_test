/**
 * WebRTC State Management
 * Provides utilities for managing connection state in a reactive way
 */
import { writable, derived } from 'svelte/store';

// Define the connection state interface
export interface WebRTCConnectionState {
  id: string;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  connectionState: RTCPeerConnectionState | string;
  iceConnectionState: RTCIceConnectionState | string;
  dataChannelState: RTCDataChannelState | string;
  latency: number | null;
  lastPingSent: number | null;
  lastPongReceived: number | null;
  verified: boolean;
  missedPings: number;
  closedAt: number | null;
  disconnectStartTime?: number | null;
  disconnectReason?: string | null;
}

// Create a store to manage all connections
const createConnectionStore = () => {
  // Use a Map for efficient key-based access
  const { subscribe, update, set } = writable<Map<string, WebRTCConnectionState>>(new Map());
  
  // Return an enhanced store with methods for managing connections
  return {
    subscribe,
    
    // Add/update a connection in the store
    updateConnection: (id: string, changes: Partial<WebRTCConnectionState>) => {
      update(connections => {
        const current = connections.get(id);
        const updated = current 
          ? { ...current, ...changes, lastUpdateTime: Date.now() }
          : { 
              id,
              pc: null,
              dc: null,
              connectionState: 'new',
              iceConnectionState: 'new',
              dataChannelState: 'connecting',
              latency: null,
              lastPingSent: null,
              lastPongReceived: null,
              verified: false,
              missedPings: 0,
              closedAt: null,
              ...changes,
              lastUpdateTime: Date.now()
            };
        
        return new Map(connections.set(id, updated));
      });
    },
    
    // Remove a connection from the store
    removeConnection: (id: string) => {
      update(connections => {
        const newMap = new Map(connections);
        newMap.delete(id);
        return newMap;
      });
    },
    
    // Get a specific connection
    getConnection: (id: string) => {
      let result: WebRTCConnectionState | undefined;
      update(connections => {
        result = connections.get(id);
        return connections;
      });
      return result;
    },
    
    // Clear all connections
    clear: () => {
      set(new Map());
    }
  };
};

// Create the main connections store
export const connections = createConnectionStore();

// Derived stores for specific connection statuses
export const activeConnections = derived(
  connections,
  $connections => 
    Array.from($connections.values()).filter(conn => 
      conn.connectionState === 'connected' && 
      conn.dataChannelState === 'open' &&
      conn.verified === true
    )
);

export const pendingConnections = derived(
  connections,
  $connections => 
    Array.from($connections.values()).filter(conn => 
      conn.connectionState !== 'connected' || 
      conn.dataChannelState !== 'open' ||
      conn.verified !== true
    )
);

export const failedConnections = derived(
  connections,
  $connections => 
    Array.from($connections.values()).filter(conn => 
      conn.connectionState === 'failed' || 
      conn.connectionState === 'closed' ||
      conn.dataChannelState === 'closed'
    )
);

export const averageLatency = derived(
  activeConnections,
  $activeConnections => {
    const validLatencies = $activeConnections
      .map(conn => conn.latency)
      .filter((latency): latency is number => latency !== null);
    
    if (validLatencies.length === 0) return null;
    
    return Math.round(
      validLatencies.reduce((sum, latency) => sum + latency, 0) / validLatencies.length
    );
  }
);