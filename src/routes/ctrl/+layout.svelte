<script lang="ts">
    import type { Snippet } from 'svelte'
    import type { LayoutData } from './$types'
    import { page } from '$app/state'

    let { data, children }: { data: LayoutData, children: Snippet } = $props ()


    import { onMount } from 'svelte'
    onMount (() => {

        console.log (page.route.id)

        const cnv = document.getElementById('cnv') as HTMLCanvasElement
        // cnv.style.position = `absolute`

        const full_screen = (e: HTMLCanvasElement) => {
            e.width = innerWidth
            e.height = innerHeight
        }

        full_screen (cnv)
        onresize = () => full_screen (cnv)
    })
</script>

<canvas id="cnv" style="position:absolute; z-index:-1" ></canvas>

<main class="flex items-center justify-center min-h-screen">
    {@render children ()}
</main>  
