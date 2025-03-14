<script lang="ts">
  import { auth, user } from '$lib/firebase'
    import { goto } from '$app/navigation'
    import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth'
    import { browser } from '$app/environment'

    $: if (browser && $user) goto (`/ctrl/active`)

    async function signInWithGoogle () {
      const provider = new GoogleAuthProvider ()
      await signInWithPopup (auth, provider)
    }
</script>

<button class="btn btn-primary" onclick={ signInWithGoogle }>Sign in with Google</button>
