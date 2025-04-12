<script lang="ts">
  import { connectionStatus } from '$lib/stores/webrtcStore';
  
  export let showDetails: boolean = false;
</script>

<div class="connection-status">
  <div class="status-indicator" class:connecting={$connectionStatus.connecting} class:connected={$connectionStatus.connected} class:reconnecting={$connectionStatus.reconnecting}>
    <div class="status-icon">
      {#if $connectionStatus.connected}
        <span class="icon-connected">✓</span>
      {:else if $connectionStatus.reconnecting}
        <span class="icon-reconnecting">↻</span>
      {:else if $connectionStatus.connecting}
        <span class="icon-connecting"></span>
      {:else}
        <span class="icon-disconnected">!</span>
      {/if}
    </div>
    
    <div class="status-text">
      {#if $connectionStatus.connected}
        Connected
      {:else if $connectionStatus.reconnecting}
        Reconnecting...
      {:else if $connectionStatus.connecting}
        Connecting...
      {:else}
        Disconnected
      {/if}
    </div>
    
    {#if $connectionStatus.statusMessage}
      <div class="status-message">{$connectionStatus.statusMessage}</div>
    {/if}
  </div>
</div>

<style>
  .connection-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 10px;
  }
  
  .status-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  
  .status-icon {
    width: 60px;
    height: 60px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: rgba(40, 50, 60, 0.3);
    margin-bottom: 8px;
  }
  
  .icon-connected {
    color: rgba(80, 220, 120, 1);
    font-size: 32px;
  }
  
  .icon-disconnected {
    color: rgba(220, 80, 80, 1);
    font-size: 32px;
  }
  
  .icon-reconnecting {
    color: rgba(220, 160, 40, 1);
    font-size: 24px;
    animation: rotate 1.5s linear infinite;
  }
  
  .icon-connecting {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 3px solid rgba(150, 180, 220, 0.2);
    border-top-color: rgba(150, 180, 220, 0.8);
    animation: spin 1.5s linear infinite;
  }
  
  .status-text {
    font-size: 1.1rem;
    font-weight: 500;
    color: rgba(180, 220, 240, 0.95);
  }
  
  .status-message {
    font-size: 0.85rem;
    color: rgba(150, 180, 200, 0.8);
    text-align: center;
    margin-top: 4px;
  }
  
  .connected .status-text {
    color: rgba(100, 220, 150, 0.95);
  }
  
  .reconnecting .status-text {
    color: rgba(220, 180, 80, 0.95);
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  @keyframes rotate {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
</style>