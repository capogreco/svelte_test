<script lang="ts">
  import { goto } from '$app/navigation'
  import { audioContext } from '$lib/stores/audioContext'
  import { onMount } from 'svelte'

  let a_cxt: AudioContext | null = null
  onMount (() => {
    a_cxt = new AudioContext ()
    a_cxt.suspend ()
  })

  const connect = async () => {
    if (a_cxt) {
      await a_cxt.resume ()
      audioContext.set (a_cxt)
      goto ('/synthesis/connecting')
    }
    else console.error ('Audio context not available')
  }
</script>

<main class="flex items-center justify-center min-h-screen">
  <main class="flex items-center justify-center min-h-screen">
    <button type="button" class="btn preset-filled-primary-500" onclick={ connect }>
      <span>CONNECT</span>
      <span>→</span>
    </button>
    <!-- Add the content for the synthesis client here -->
  </main>
  </main>
