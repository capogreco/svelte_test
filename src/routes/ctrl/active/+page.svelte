<script lang="ts">
    import { user, db } from '$lib/firebase'
    import { ref, set, get, remove, onValue } from 'firebase/database'
    import { browser }  from '$app/environment'
    import { goto }     from '$app/navigation'
    import { onMount }  from 'svelte'

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

    $: if (browser && !$user)  goto('/ctrl')


    onMount (async () => {
        console.log (`iceServers:`, iceServers)
        const pc = new RTCPeerConnection ({
            iceServers
        })
        const dataChannel = pc.createDataChannel ('ctrl')
        dataChannel.onopen = () => console.log ('Data channel opened')
        dataChannel.onmessage = e => console.log (`Data channel message: ${ e.data }`)
        dataChannel.onclose = () => console.log ('Data channel closed')
        dataChannel.onerror = e => console.error (`Data channel error: ${ e }`)

        const offer = await pc.createOffer ()
        await pc.setLocalDescription (offer)
        const { sdp } = offer

        if (typeof sdp === 'string') startCtrlClient (pc, sdp)
        else console.error ('Invalid SDP:', sdp)
    })

    async function startCtrlClient (pc: RTCPeerConnection, sdp: string) {
        console.log ('Starting Ctrl Client')
        let ctrlClientId
        if (typeof crypto !== `undefined` && typeof crypto.randomUUID === `function`) {
            ctrlClientId = crypto.randomUUID ()
        } else {
            ctrlClientId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace (/[xy]/g, c => {
                const r = Math.random () * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8)
                return v.toString (16)
            })
        }

        // const activeCtrlClientIdRef = ref (db, `activeCtrlClientID`)
        // await set (activeCtrlClientIdRef, ctrlClientId)

        pc.onicecandidate = e => {
            if (e.candidate) {
                const iceCandidateRef = ref (db, `ctrlOffers/${ ctrlClientId }/iceCandidates`) //Store ICE candidates
                set (iceCandidateRef, e.candidate.toJSON ())//Use push for a list of candidates
                console.log('ICE candidate:', e.candidate.toJSON ())
            }
        }

        async function removeWaitingRoom (ctrlClientId: string) {
            try {
                await remove (ref (db, `waitingRooms/${ ctrlClientId }`))
                console.log(`Deleted waiting room: ${ ctrlClientId }`)
            } catch (error) {
                console.error (`Error deleting waiting room ${ ctrlClientId }:`, error)
            }
        }


        try {
            console.log (`Deleting existing waiting rooms`)
            const waitingRoomsRef = ref (db, 'waitingRooms')
            const snapshot = await get (waitingRoomsRef)
            if (snapshot.exists ()) {
                snapshot.forEach(childSnapshot => {
                    const ctrlClientId = childSnapshot.key
                    removeWaitingRoom(ctrlClientId)
                })
            }
            console.log (`Existing waiting rooms deleted`)
        } catch (error) { 
            console.error(`Error deleting existing waiting rooms: ${ error }`) 
        }

        const waitingRoomRef = ref (db, `waitingRooms/${ ctrlClientId }`)
        try {
            console.log (`Creating waiting room: ${ ctrlClientId }`)
            await set (waitingRoomRef, true)
            console.log (`Waiting room created: ${ ctrlClientId }`)
        } catch (error) { console.error (`Error creating waiting room: ${ error }`) }

        const offerRef = ref (db, `ctrlOffers/${ ctrlClientId }/offer`)
        try {
            await set (offerRef, sdp)
        } catch (error) { console.error (`Error setting offer: ${ error }`) }

        const answerRef = ref (db, `ctrlOffers/${ ctrlClientId }/answer`)
        onValue (answerRef, async snapshot => {
            const answer = snapshot.val ()
            if (answer) {
                try {
                    await pc.setRemoteDescription ({ type: "answer", sdp: answer })
                    console.log ("Remote description set (ctrl)")
                } catch (e) {
                    console.error("Error setting remote description (ctrl):", e)
                }
            }
        })

        onValue(ref(db, `ctrlOffers/${ctrlClientId}/synthIceCandidates`), async (snapshot) => {
            const iceCandidate = snapshot.val ()
            if (iceCandidate) {
                try {
                    await pc.addIceCandidate (iceCandidate)
                    console.log ("ICE candidate added (ctrl):", iceCandidate)
                } catch (e) {
                    console.error ("Error adding ICE candidate (ctrl):", e)
                }
            }
        })

    }
</script>
<!-- <link rel="stylesheet" href="src/app.css"> -->
<h1 class="text-3xl font-bold underline">ACTIVE</h1>