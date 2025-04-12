/**
 * WebRTC Navigation Utilities
 * This file contains utility functions for safely navigating between pages
 * while preserving WebRTC connections.
 */
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { protectDataChannel, protectPeerConnection, setupGlobalRecoveryMechanism } from './protection';

/**
 * Options for protected navigation
 */
interface NavigationOptions {
  ctrlId: string;
  url: string;
  params?: Record<string, string>;
  ensureTimeout?: number;
  retryCount?: number;
  synthetic?: boolean; // Whether to use direct location.href (true) or goto (false)
}

/**
 * Stores WebRTC objects in various global storage mechanisms
 * to ensure they survive page transitions.
 */
export function prepareForNavigation(
  dataChannel: RTCDataChannel, 
  peerConnection: RTCPeerConnection,
  ctrlId: string
): void {
  if (!browser) return;
  
  console.log(`[Navigation] 🔒 Preparing WebRTC objects for navigation`);
  
  // Apply protections to both objects
  protectDataChannel(dataChannel, ctrlId);
  protectPeerConnection(peerConnection, ctrlId);
  
  // Setup recovery mechanisms
  setupGlobalRecoveryMechanism(dataChannel, peerConnection, ctrlId);
  
  // Store in session storage
  if (browser) {
    sessionStorage.setItem('dataChannelState', 'open');
    sessionStorage.setItem('synthConnectionId', ctrlId);
    sessionStorage.setItem('protectedNavigation', 'true');
  }
  
  console.log(`[Navigation] ✅ WebRTC objects prepared for navigation`);
}

/**
 * Navigates to a new page while preserving WebRTC connections
 */
export function navigateWithProtection(options: NavigationOptions): void {
  if (!browser) return;
  const { 
    ctrlId, 
    url, 
    params = {}, 
    ensureTimeout = 250,
    retryCount = 1,
    synthetic = true
  } = options;
  
  const defaultParams = {
    ctrl: ctrlId,
    protect: 'true'
  };
  
  // Combine default and custom parameters
  const allParams = { ...defaultParams, ...params };
  
  // Build query string
  const queryString = Object.entries(allParams)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  
  // Final URL with query parameters
  const fullUrl = `${url}${url.includes('?') ? '&' : '?'}${queryString}`;
  
  // Wait briefly to ensure all preparations have taken effect
  setTimeout(() => {
    try {
      console.log(`[Navigation] 🚀 Navigating to ${fullUrl}`);
      
      // Use direct location navigation for maximum reliability
      if (synthetic) {
        window.location.href = fullUrl;
      } else {
        goto(fullUrl);
      }
    } catch (e) {
      console.error(`[Navigation] ❌ Error during navigation:`, e);
      
      // Retry with backoff if we still have retries left
      if (retryCount > 0) {
        console.log(`[Navigation] 🔄 Will retry in 1000ms (${retryCount} retries left)`);
        setTimeout(() => {
          navigateWithProtection({
            ...options,
            retryCount: retryCount - 1,
            ensureTimeout: ensureTimeout * 1.5 // Increase timeout for next attempt
          });
        }, 1000);
      }
    }
  }, ensureTimeout);
}

/**
 * Attempts to recover WebRTC objects from global storage after navigation
 * @returns An object containing the recovered peer connection, data channel, and connection ID
 */
export function recoverConnectionAfterNavigation() {
  if (!browser) return { peerConnection: null, dataChannel: null, connectionId: null };
  
  console.log(`[Navigation] 🔍 Attempting to recover WebRTC objects after navigation`);
  
  // Try to recover from all possible storage locations
  let recoveredPC = window.syntheticPeerConnection || window._backupPeerConnection;
  let recoveredDC = window.syntheticDataChannel || window._backupDataChannel;
  let connectionId = window.synthControllerID || window._backupCtrlId || sessionStorage.getItem('synthConnectionId');
  
  // Check if we have guardian backup
  if ((!recoveredPC || !recoveredDC) && window._webrtcGuardian) {
    console.log(`[Navigation] ℹ️ Using guardian backup objects`);
    recoveredPC = window._webrtcGuardian.originalConnection;
    recoveredDC = window._webrtcGuardian.originalChannel;
    connectionId = connectionId || window._webrtcGuardian.controllerId;
  }
  
  // Check URL for connection ID as last resort
  if (!connectionId && browser) {
    const urlParams = new URLSearchParams(window.location.search);
    connectionId = urlParams.get('ctrl');
    
    if (connectionId) {
      console.log(`[Navigation] ℹ️ Recovered controller ID from URL: ${connectionId}`);
      sessionStorage.setItem('synthConnectionId', connectionId);
    }
  }
  
  // If we recovered objects, reapply protection
  if (recoveredDC) {
    protectDataChannel(recoveredDC, connectionId || 'unknown');
  }
  
  if (recoveredPC) {
    protectPeerConnection(recoveredPC, connectionId || 'unknown');
  }
  
  const success = !!(recoveredPC && recoveredDC && connectionId);
  console.log(`[Navigation] ${success ? '✅ Successfully' : '❌ Failed to'} recover WebRTC objects`);
  
  return {
    peerConnection: recoveredPC,
    dataChannel: recoveredDC,
    connectionId,
    success
  };
}