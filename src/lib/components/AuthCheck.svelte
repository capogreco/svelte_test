<script lang="ts">
   import { auth, user }  from '$lib/firebase'
   import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth'
   import { goto } from '$app/navigation'
   import { page } from '$app/stores'
   import { browser } from '$app/environment'

   async function signInWithGoogle () {
      const provider = new GoogleAuthProvider ()
      const u = await signInWithPopup (auth, provider)
      console.log (u)
   }

   const handleSignOut = async () => {
      await signOut (auth)
      goto (`/ctrl`)
   }

</script>

{#if $user}
   <button 
      class="absolute top-2 right-2 terminal-button-mini" 
      onclick={ () => handleSignOut () }
   >
      LOG OUT
   </button>
   {#if $user.uid === `ap13XJUrp7duHAPYfubdKmgRZXd2`}
      <slot />
   {:else}
      <h1 class="terminal-error-heading">
         USER NOT AUTHORIZED
      </h1>
   {/if}
{:else}
   <button type="button" class="terminal-button terminal-button-primary" onclick={ signInWithGoogle }>
      LOGIN
   </button>
{/if}

<style>
   .terminal-button {
      font-family: 'Courier New', monospace;
      background: rgba(20, 35, 50, 0.8);
      color: rgba(80, 230, 180, 0.9);
      border: 1px solid rgba(80, 230, 180, 0.4);
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 0.8rem;
      letter-spacing: 1px;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
      text-transform: uppercase;
      font-weight: bold;
   }

   .terminal-button:hover {
      background: rgba(30, 45, 60, 0.9);
      border-color: rgba(80, 230, 180, 0.8);
      box-shadow: 0 0 10px rgba(80, 230, 180, 0.3);
   }
   
   .terminal-button-mini {
      font-family: 'Courier New', monospace;
      background: rgba(20, 30, 40, 0.5);
      color: rgba(150, 150, 150, 0.7);
      border: 1px solid rgba(100, 100, 100, 0.3);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.65rem;
      display: flex;
      align-items: center;
      gap: 3px;
      transition: all 0.2s ease;
      opacity: 0.6;
      z-index: 10;
   }

   .terminal-button-mini:hover {
      background: rgba(30, 45, 60, 0.7);
      color: rgba(80, 230, 180, 0.9);
      border-color: rgba(80, 230, 180, 0.6);
      opacity: 1;
   }

   .terminal-button-primary {
      background: rgba(20, 50, 40, 0.8);
      border-color: rgba(80, 230, 180, 0.6);
   }

   .terminal-prompt {
      color: rgba(80, 230, 180, 1);
      font-weight: bold;
   }
   
   .terminal-error-heading {
      font-family: 'Courier New', monospace;
      color: rgba(255, 100, 100, 0.9);
      font-size: 2rem;
      letter-spacing: 2px;
      display: flex;
      align-items: center;
      gap: 10px;
      text-transform: uppercase;
   }
</style>
