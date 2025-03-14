<script lang="ts">
    import { auth, user } from '$lib/firebase'
    import { browser }    from '$app/environment'
    import { signOut }    from 'firebase/auth'
    import { goto }       from '$app/navigation'

    $: if (browser && !$user) goto (`/ctrl`)
</script>

{#if $user}
    <h2 class="card-title">Welcome, { $user.displayName }</h2>
    <p class="text-center text-success">You are logged in</p>
    <button class="btn btn-warning" onclick={ () => signOut (auth) }>Sign out</button>
{:else}
    <p class="text-center text-danger">User not logged in</p>
{/if}