/**
 * WebRTC Connection Monitoring Utilities
 * This file contains utility functions for monitoring WebRTC connections
 * health and detecting disconnects in a robust way.
 */

// Constants for connection monitoring
export const CONNECTION_PING_INTERVAL = 3000; // Send ping every 3 seconds
export const CONNECTION_TIMEOUT = 20000; // Consider connection dead after 20 seconds of no response
export const CONNECTION_MISSED_PINGS_THRESHOLD = 3; // Only mark as failed after 3 consecutive missed pings

/**
 * Options for connection monitoring
 */
export interface MonitoringOptions {
  onDisconnect?: (reason: string) => void;
  onReconnect?: () => void;
  onLatencyMeasured?: (latency: number) => void;
  pingInterval?: number;
  timeout?: number;
  missedPingsThreshold?: number;
  id?: string;
}

/**
 * Create a ping message
 * @returns String with ping message format including timestamp
 */
export function createPingMessage(): string {
  return `ping:${Date.now()}`;
}

/**
 * Process a pong message to extract the original timestamp
 * @param message - The pong message from the peer
 * @returns The original timestamp or null if invalid
 */
export function extractPongTimestamp(message: string): number | null {
  if (!message.startsWith('pong:')) return null;
  
  const timestampStr = message.substring(5);
  const timestamp = parseInt(timestampStr, 10);
  
  return isNaN(timestamp) ? null : timestamp;
}

/**
 * Calculate round-trip latency from a pong timestamp
 * @param pingTimestamp - The timestamp when the ping was sent
 * @returns The round-trip latency in milliseconds
 */
export function calculateLatency(pingTimestamp: number): number {
  return Date.now() - pingTimestamp;
}

/**
 * Starts connection monitoring for a WebRTC data channel
 * @param dataChannel - The data channel to monitor
 * @param options - Monitoring options
 * @returns An object with control functions (stop, sendPing)
 */
export function startConnectionMonitoring(
  dataChannel: RTCDataChannel,
  options: MonitoringOptions = {}
) {
  // Default options
  const id = options.id || 'unknown';
  const pingInterval = options.pingInterval || CONNECTION_PING_INTERVAL;
  const timeout = options.timeout || CONNECTION_TIMEOUT;
  const missedPingsThreshold = options.missedPingsThreshold || CONNECTION_MISSED_PINGS_THRESHOLD;
  
  // State variables
  let lastPongReceived = Date.now();
  let missedPings = 0;
  let intervalId: number | null = null;
  let isStopped = false;
  
  // Clear any existing interval
  if (intervalId) {
    window.clearInterval(intervalId);
  }
  
  // Function to send a ping
  const sendPing = () => {
    if (!dataChannel || dataChannel.readyState !== 'open' || isStopped) return false;
    
    try {
      const pingMessage = createPingMessage();
      dataChannel.send(pingMessage);
      return true;
    } catch (error) {
      console.error(`[Monitor ${id}] Failed to send ping:`, error);
      return false;
    }
  };
  
  // Start the monitoring interval
  intervalId = window.setInterval(() => {
    if (isStopped) return;
    
    // Only send pings if data channel is open
    if (dataChannel && dataChannel.readyState === 'open') {
      sendPing();
      
      // Check for timed-out connection
      const timeSinceLastPong = Date.now() - lastPongReceived;
      
      if (timeSinceLastPong > timeout) {
        // Increment missed pings counter
        missedPings++;
        console.warn(`[Monitor ${id}] Missed ping #${missedPings} (no response for ${timeSinceLastPong/1000}s)`);
        
        // Only disconnect after hitting the threshold
        if (missedPings >= missedPingsThreshold) {
          console.warn(`[Monitor ${id}] Connection timed out after ${missedPings} missed pings`);
          options.onDisconnect?.('timeout');
        } else {
          // Try another ping immediately for faster recovery
          sendPing();
        }
      } else if (missedPings > 0) {
        // Connection recovered
        console.log(`[Monitor ${id}] Connection recovered, resetting missed pings counter`);
        missedPings = 0;
        options.onReconnect?.();
      }
    }
  }, pingInterval);
  
  // Function to handle a pong message
  const handlePong = (pingTimestamp: number) => {
    if (isStopped) return;
    
    // Calculate round-trip time
    const latency = calculateLatency(pingTimestamp);
    
    // Update last pong timestamp
    lastPongReceived = Date.now();
    
    // Reset missed pings counter on successful pong
    if (missedPings > 0) {
      console.log(`[Monitor ${id}] Connection recovered after ${missedPings} missed pings`);
      missedPings = 0;
      options.onReconnect?.();
    }
    
    // Call latency callback if provided
    options.onLatencyMeasured?.(latency);
    
    return latency;
  };
  
  // Function to stop monitoring
  const stop = () => {
    isStopped = true;
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };
  
  console.log(`[Monitor ${id}] Started connection monitoring with interval ${pingInterval}ms`);
  
  // Return control functions
  return {
    sendPing,
    handlePong,
    stop,
    getState: () => ({
      lastPongReceived,
      missedPings,
      isActive: !isStopped && intervalId !== null
    })
  };
}