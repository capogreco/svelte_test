<script lang="ts">
    import { audioContext } from "$lib/stores/audioContext"
    import { onMount } from "svelte"
    import { db } from "$lib/firebase"
    import { query, limitToFirst, ref, onValue } from "firebase/database"


    let a_cxt : AudioContext | null = null

    $: audioContext.subscribe (v => a_cxt = v)

    onMount (() => {
        if (a_cxt) console.dir (`audio context is ${ a_cxt.state }`)
        startSynthesisClient ()
    })

    async function startSynthesisClient () {
        let synthClientId
        if (typeof crypto !== `undefined` && typeof crypto.randomUUID === `function`) {
            synthClientId = crypto.randomUUID ()
        } else {
            synthClientId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = Math.random () * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8)
                return v.toString (16)
            })
        }

        const waitingRoomsRef = ref (db, `waitingRooms`)
        const queryRef = query (waitingRoomsRef, limitToFirst (1))

        let ctrlClientId: string | null = null

        onValue (queryRef, snapshot => {
            console.log ('Checking for waiting rooms')
            snapshot.forEach (childSnapshot => {
                const { key } = childSnapshot
                console.log (`Found waiting room: ${ key }`)
                ctrlClientId = key
            })
        })

        // console.log ('Starting Synthesis Client')
        // const pc = new RTCPeerConnection ()
        // const dataChannel = pc.createDataChannel ('synthesis')
        // dataChannel.onopen = () => console.log ('Data channel opened')
        // dataChannel.onmessage = e => console.log (`Data channel message: ${ e.data }`)
        // dataChannel.onclose = () => console.log ('Data channel closed')
        // dataChannel.onerror = e => console.error (`Data channel error: ${ e }`)

        // const offer = await pc.createOffer ()
        // await pc.setLocalDescription (offer)
        // const { sdp } = offer

        // if (typeof sdp === 'string') startSynthesisClient (pc, sdp)
        // else console.error ('Invalid SDP:', sdp)
    }
</script>

<main class="flex items-center justify-center min-h-screen">
    <a href="/synthesis/connecting"> 
        <h1 class="text-3xl font-bold underline">CONNECTING</h1>
    </a>
    <!-- Add the content for the control client here -->
</main>
