<script lang="ts">
    import type { Snippet } from 'svelte'
    import { onMount } from 'svelte'
    import AuthCheck from '$lib/components/AuthCheck.svelte'

    let { children }: { children: Snippet } = $props()

    onMount (() => {
        const cnv = document.getElementById('cnv') as HTMLCanvasElement
        const full_screen = (e: HTMLCanvasElement) => {
            e.width  = innerWidth
            e.height = innerHeight
        }

        full_screen (cnv)
        onresize = () => full_screen (cnv)
    })

</script>

<canvas id="cnv" style="position:absolute; z-index:-1" ></canvas>

<main class="flex flex-col items-center justify-center min-h-screen">
    <AuthCheck>
        {@render children ()}
    </AuthCheck>
</main>  
