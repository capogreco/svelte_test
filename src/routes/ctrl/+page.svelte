<script lang="ts">
   import { user } from '$lib/firebase'
   import { onMount } from 'svelte'
   import { goto } from '$app/navigation';

   onMount (() => {
      if ($user) goto (`/ctrl/active`)
   })

</script>

<h1>HELLO { $user?.displayName?.toUpperCase () }</h1>