<script lang="ts">
    import { user } from '$lib/firebase'
    import { browser }    from '$app/environment'
    import { goto }       from '$app/navigation'

    $: if (browser && !$user)  goto('/ctrl')
</script>
<!-- <link rel="stylesheet" href="src/app.css"> -->
<h1 class="text-3xl font-bold underline">ACTIVE</h1>