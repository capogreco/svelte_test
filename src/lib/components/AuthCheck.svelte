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
      class="absolute top-4 right-4 btn preset-outlined-surface-500" 
      onclick={ () => handleSignOut () }
   >Sign out</button>
   {#if $user.uid === `ap13XJUrp7duHAPYfubdKmgRZXd2`}
      <slot />
   {:else}
      <h1 class="text-3xl font-bold underline">USER NOT AUTHORISED</h1>
   {/if}
{:else}
   <button type="button" class="btn preset-outlined-primary-500" onclick={ signInWithGoogle }>
      SIGN IN
   </button>
{/if}
