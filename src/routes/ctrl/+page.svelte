<script lang="ts">
    import { auth } from '$lib/firebase'
    import { GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth'
    async function signInWithGoogle () {
        const provider = new GoogleAuthProvider ()
        const user = await signInWithPopup (auth, provider)
        console.log(user)
    }
</script>

<button class="text-3xl font-bold underline" onclick={ signInWithGoogle }>LOG IN</button>
   <!-- Add the content for the control client here -->
 