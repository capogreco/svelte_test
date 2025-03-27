<!-- Filename: src/routes/synthesis/connecting/%2Bpage.svelte -->
<script lang="ts">
    import { audioContext } from "$lib/stores/audioContext"
    import { onMount } from "svelte"
    import { db } from "$lib/firebase"
    import { query, limitToFirst, ref, set, onValue } from "firebase/database"

    interface IceServer {
        urls: string | string[];
        username?: string;
        credential?: string;
    }

    interface PageData {
        iceServers: IceServer[];
        error?: string;
        twilioPhone?: string;
    }

    export let data: PageData

    $: ({ iceServers, error } = data)

    let a_cxt : AudioContext | null = null

    $: audioContext.subscribe (v => a_cxt = v)

    onMount (() => {
        if (a_cxt) console.dir (`audio context is ${ a_cxt.state }`)
        startSynthesisClient ()
    })

    async function startSynthesisClient () {
        console.log ('Starting Synthesis Client')

        let synthClientId
        if (typeof crypto !== `undefined` && typeof crypto.randomUUID === `function`) {
            synthClientId = crypto.randomUUID ()
        } else {
            synthClientId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = Math.random () * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8)
                return v.toString (16)
            })
        }

        console.log (`Synthesis Client ID is: ${ synthClientId }`)

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

        const answerRef       = ref (db, `ctrlOffers/${ ctrlClientId }/answer`)
        const iceCandidateRef = ref (db, `ctrlOffers/${ ctrlClientId }/iceCandidates`)

        console.log (`iceServers:`, iceServers)
        const pc = new RTCPeerConnection ({
            iceServers
        })

        pc.onicecandidate = event => {
            if (event.candidate) {
                set (ref (db, `ctrlOffers/${ ctrlClientId }/synthIceCandidates`), event.candidate)
                console.log ('ICE candidate (synthesis):', event.candidate)
            }
        }

        pc.onicegatheringstatechange = () => {
          console.log ('ICE gathering state:', pc.iceGatheringState)
        }

        pc.ondatachannel = event => {
            const dataChannel = event.channel
            dataChannel.onopen    = () => console.log ('Data channel opened (synthesis)')
            dataChannel.onmessage = e  => console.log (`Data channel message (synthesis): ${ e.data }`)
            dataChannel.onclose   = () => console.log ('Data channel closed (synthesis)')
            dataChannel.onerror   = e  => console.error (`Data channel error (synthesis): ${ e }`)
        }

        const offerRef = ref (db, `ctrlOffers/${ ctrlClientId }/offer`)
        onValue (offerRef, async snapshot => {
            console.log ('Offer received (synthesis)')
            const offer = await snapshot.val ()
            console.log("Offer value:", offer)
            if (offer) {
                // console.log("Offer value:", offer)
                try {
                    await pc.setRemoteDescription ({ type: "offer", sdp: offer })
                    console.log ("Remote description set (synthesis)")
                    const answer = await pc.createAnswer ()
                    await pc.setLocalDescription(answer)
                    console.log ("Local description set (synthesis)")
                    set (answerRef, answer.sdp)
                    console.log ("Answer sent (synthesis)")
                    onValue (ref (db, `ctrlOffers/${ ctrlClientId }/iceCandidates`), async (snapshot) => {
                        const iceCandidate = snapshot.val ()
                        if (iceCandidate) {
                            try {
                                await pc.addIceCandidate (iceCandidate)
                                console.log ("ICE candidate added (synthesis):", iceCandidate)
                            } catch (e) {
                                console.error ("Error adding ICE candidate (synthesis):", e);
                            }
                        }
                    })
                } catch (error) {
                    console.error ("Error setting descriptions or creating answer (synthesis):", error);
                }
            }
        });

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
