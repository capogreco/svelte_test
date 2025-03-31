<!-- Filename: src/routes/synthesis/connecting/%2Bpage.svelte -->
<script lang="ts">
import { audioContext } from "$lib/stores/audioContext";
import { onMount } from "svelte";
import { db } from "$lib/firebase";
import { query, limitToFirst, ref, set, onValue } from "firebase/database";

interface IceSvr {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface PgData {
  iceServers: IceSvr[];
  error?: string;
  twilioPhone?: string;
}

export let data: PgData;
$: ({ iceServers } = data)
let a_cxt: AudioContext | null = null
$: audioContext.subscribe (v => (a_cxt = v))

onMount(() => {
  if (a_cxt) console.dir (`AC state: ${ a_cxt.state }`)
  startSynthesisClient ()
});

async function startSynthesisClient () {
  console.log ('Starting Synthesis Client')
  const synthId = crypto?.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random () * 16) | 0;
      const v = c == 'x' ? r : (r & 0x3) | 0x8;
      return v.toString (16)
    });
  console.log (`Synth ID: ${synthId}`)

  const waitsRef = ref (db, `waitingRooms`)
  const firstWaitQuery = query (waitsRef, limitToFirst (1))
  let ctrlId: string | null = null

  onValue (firstWaitQuery, snapshot => {
    console.log ('Checking for waiting control client.')
    snapshot.forEach (childSnap => {
      ctrlId = childSnap.key
      console.log (`Found control client ID: ${ ctrlId }`)
      setupWebRTC (ctrlId)
    })
    if (!snapshot.exists ()) {
      console.log ('No waiting control client found.')
      // Optionally handle the case where no control client is waiting
    }
  });
}

async function setupWebRTC (ctrlId: string) {
  if (!ctrlId) {
    console.warn ('Control client ID not yet available.')
    return
  }

  console.log ('iceServers:', iceServers)
  const pc = new RTCPeerConnection({ iceServers })

  pc.onicecandidate = async event => {
    if (event.candidate) {
      // console.log ('ICE candidate event triggerred !!!!!!!!!!!')
      try {
        await set (ref (db, `ctrlOffers/${ ctrlId }/synthIce`), event.candidate.toJSON ())
        console.log ('ICE candidate sent:', event.candidate.toJSON ())
      } catch (e) {
        console.error ('Error setting ICE candidate:', e)
      }
    }
  }

  pc.onicegatheringstatechange = () =>
    console.log ('ICE gathering state:', pc.iceGatheringState)

  pc.ondatachannel = event => {
    console.log ('Data channel event:', event)
    const dataChannel = event.channel
    dataChannel.onopen = () => console.log('DC opened')
    dataChannel.onmessage = e => console.log(`DC msg: ${e.data}`)
    dataChannel.onclose = () => console.log('DC closed')
    dataChannel.onerror = e => console.error(`DC err:`, e)
  }


  onValue (ref (db, `ctrlOffers/${ ctrlId }/offer`), async snapshot => {
    const offer = snapshot.val ()
    if (offer) {
    //   console.log('Offer received (synth):', offer);
      try {
        await pc.setRemoteDescription ({ type: 'offer', sdp: offer })
        console.log ('Remote description set (synth)')
        const answer = await pc.createAnswer ()
        await pc.setLocalDescription (answer)
        console.log ('Local description set (synth)')
        set (ref (db, `ctrlOffers/${ ctrlId }/answer`), answer.sdp)
        console.log ('Answer sent (synth)');

        onValue (ref (db, `ctrlOffers/${ ctrlId }/ice`), async (snap) => {
          const ice = snap.val ()
          if (ice) {
            try {
              await pc.addIceCandidate (ice)
              console.log ('ICE added (synth):', ice)
            } catch (e) {
              console.error('Error adding ICE (synth):', e)
            }
          }
        });
      } catch (error) {
        console.error('Error setting descriptions/creating answer:', error);
      }
    } else {
      console.log('No offer received yet.');
    }
  });
}
</script>

<main class="flex items-center justify-center min-h-screen">
    <a href="/synthesis/connecting"> 
        <h1 class="text-3xl font-bold underline">CONNECTING</h1>
    </a>
    <!-- Add the content for the control client here -->
</main>
