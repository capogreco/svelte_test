/**
 * WebRTC Connection Protection Utilities
 * This file contains utility functions for protecting WebRTC connections
 * from unexpected closure, especially during navigation between pages.
 */

/**
 * Applies ultra protection to a data channel to prevent it from being closed
 * @param dataChannel - The RTCDataChannel to protect
 * @param id - An identifier for logging purposes
 * @returns The protected data channel (same instance with overrides)
 */
export function protectDataChannel(dataChannel: RTCDataChannel, id: string = 'unknown'): RTCDataChannel {
  if (!dataChannel) return dataChannel;

  // Save original methods
  const originalClose = dataChannel.close.bind(dataChannel);
  const originalSend = dataChannel.send.bind(dataChannel);
  
  // Override close to be a no-op
  dataChannel.close = function() {
    console.log(`[Protected DC ${id}] ❌ BLOCKED data channel close`);
    return Promise.resolve() as any;
  };
  
  // Override send to handle errors gracefully
  dataChannel.send = function(data) {
    try {
      if (this.readyState === 'open') {
        return originalSend(data);
      } else {
        console.log(`[Protected DC ${id}] Message dropped - channel not open (${this.readyState})`);
        return true; // Return success to caller
      }
    } catch (e) {
      console.warn(`[Protected DC ${id}] Error in protected send:`, e);
      return false; // Return failure but don't throw
    }
  };
  
  // Disable all event handlers
  ['onclose', 'onerror', 'onopen', 'onmessage', 'bufferedamountlow'].forEach(event => {
    if (dataChannel[event]) {
      console.log(`[Protected DC ${id}] Disabling ${event} handler`);
      dataChannel[event] = null;
    }
  });
  
  console.log(`[Protected DC ${id}] ✅ Data channel protected`);
  return dataChannel;
}

/**
 * Applies ultra protection to a peer connection to prevent it from being closed
 * @param peerConnection - The RTCPeerConnection to protect
 * @param id - An identifier for logging purposes
 * @returns The protected peer connection (same instance with overrides)
 */
export function protectPeerConnection(peerConnection: RTCPeerConnection, id: string = 'unknown'): RTCPeerConnection {
  if (!peerConnection) return peerConnection;
  
  // Save original methods
  const originalClose = peerConnection.close.bind(peerConnection);
  
  // Override close to be a no-op
  peerConnection.close = function() {
    console.log(`[Protected PC ${id}] ❌ BLOCKED peer connection close`);
    return Promise.resolve() as any;
  };
  
  // Disable critical event handlers
  [
    'onconnectionstatechange', 
    'oniceconnectionstatechange',
    'onicegatheringstatechange', 
    'onnegotiationneeded'
  ].forEach(event => {
    if (peerConnection[event]) {
      console.log(`[Protected PC ${id}] Disabling ${event} handler`);
      peerConnection[event] = null;
    }
  });
  
  console.log(`[Protected PC ${id}] ✅ Peer connection protected`);
  return peerConnection;
}

/**
 * Creates heartbeat mechanism to keep connection alive
 * @param dataChannel - The data channel to keep alive
 * @param id - Connection identifier for logging
 * @returns Array of interval IDs that can be cleared later
 */
export function createHeartbeatMechanism(dataChannel: RTCDataChannel, id: string = 'unknown'): number[] {
  const intervals: number[] = [];
  const heartbeatTimes = [500, 1500, 3000]; // Staggered intervals
  let pingCounter = 0;
  
  // Create multiple heartbeats at different intervals for redundancy
  heartbeatTimes.forEach((interval, idx) => {
    const intervalId = window.setInterval(() => {
      pingCounter++;
      try {
        if (dataChannel && dataChannel.readyState === 'open') {
          dataChannel.send(`heartbeat:${pingCounter}:${idx}`);
          if (pingCounter % 10 === 0) {
            console.log(`[Heartbeat ${id}] Sent ping #${pingCounter} on interval ${idx}`);
          }
        }
      } catch (e) {
        console.warn(`[Heartbeat ${id}] Error sending heartbeat:`, e);
      }
    }, interval);
    
    intervals.push(intervalId);
  });
  
  console.log(`[Heartbeat ${id}] ✅ Started heartbeat mechanism on ${heartbeatTimes.length} intervals`);
  return intervals;
}

/**
 * Setup global recovery mechanisms for WebRTC objects
 * Makes protected versions of connections available in global scope
 */
export function setupGlobalRecoveryMechanism(
  dataChannel: RTCDataChannel, 
  peerConnection: RTCPeerConnection,
  connectionId: string
): void {
  if (!window) return;
  
  // Store in standard locations for cross-page access
  window.syntheticDataChannel = dataChannel;
  window.syntheticPeerConnection = peerConnection;
  window.synthControllerID = connectionId;
  
  // Store in backup locations for redundancy
  window._backupDataChannel = dataChannel;
  window._backupPeerConnection = peerConnection;
  window._backupCtrlId = connectionId;
  
  // Store connection state
  window.syntheticConnectionState = {
    dcId: dataChannel?.id,
    pcId: peerConnection?.id,
    ctrlId: connectionId,
    originalTime: Date.now(),
    dcState: dataChannel?.readyState,
    pcState: peerConnection?.connectionState,
    iceState: peerConnection?.iceConnectionState
  };
  
  console.log(`[GlobalRecovery] ✅ Set up global recovery mechanism for connection ${connectionId}`);
}

/**
 * Creates a proxy object that pretends to be a data channel but is immune to closure
 * @param realDataChannel - The actual data channel to proxy
 * @param id - Connection identifier for logging
 * @returns A proxy object that mimics the data channel but can't be closed
 */
export function createDataChannelProxy(realDataChannel: RTCDataChannel, id: string = 'unknown'): any {
  const originalSend = realDataChannel.send.bind(realDataChannel);
  
  // Create a proxy object that captures the state of the channel
  const proxyDataChannel = {
    // Static properties - always return fixed values
    readyState: 'open',  // Always report as open
    bufferedAmount: realDataChannel.bufferedAmount || 0,
    bufferedAmountLowThreshold: realDataChannel.bufferedAmountLowThreshold || 0,
    maxPacketLifeTime: realDataChannel.maxPacketLifeTime,
    maxRetransmits: realDataChannel.maxRetransmits,
    negotiated: realDataChannel.negotiated,
    id: realDataChannel.id,
    ordered: realDataChannel.ordered,
    protocol: realDataChannel.protocol,
    label: realDataChannel.label,
    binaryType: realDataChannel.binaryType,
    
    // Methods
    close: function() {
      console.log(`[ProxyDC ${id}] ❌ BLOCKED data channel close attempt`);
      return Promise.resolve();
    },
    
    send: function(data) {
      try {
        if (realDataChannel && realDataChannel.readyState === 'open') {
          return originalSend(data);
        } else {
          console.log(`[ProxyDC ${id}] ⚠️ Silently dropping message - real DC not ready`);
          return true;
        }
      } catch (e) {
        console.warn(`[ProxyDC ${id}] 🛠️ Handled error in send: ${e.message}`);
        return false;
      }
    },
    
    // Access to real object for diagnostics
    _getRealChannel: function() {
      return realDataChannel;
    }
  };
  
  console.log(`[ProxyDC ${id}] ✅ Created proxy for data channel`);
  return proxyDataChannel;
}

// Type definitions for the global window object
declare global {
  interface Window {
    syntheticPeerConnection: RTCPeerConnection | null;
    syntheticDataChannel: RTCDataChannel | null;
    synthControllerID?: string;
    _backupPeerConnection?: RTCPeerConnection | null;
    _backupDataChannel?: RTCDataChannel | null;
    _backupCtrlId?: string;
    _navProtectionActive?: boolean;
    syntheticConnectionState?: any;
    _webrtcGuardian?: any;
    globalDCProtection?: any;
    globalDCGuardianInstalled?: boolean;
    globalDCGuardianInterval?: number;
    recentlyOpenedChannels?: Record<string, any>;
  }
}