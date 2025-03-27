<!-- Filename: src/routes/ctrl/active/%2Bpage.svelte -->
<script lang="ts">
import { user, db } from '$lib/firebase';
import { ref, set, get, remove, onValue } from 'firebase/database';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { onMount } from 'svelte';

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
$: ({ iceServers, error } = data);
$: if (browser && !$user) goto('/ctrl');

onMount(async () => {
  console.log('iceServers:', iceServers);
  const pc = new RTCPeerConnection({ iceServers });
  const dc = pc.createDataChannel('ctrl');
  dc.onopen = () => console.log('DC opened');
  dc.onmessage = (e) => console.log(`DC msg: ${e.data}`);
  dc.onclose = () => console.log('DC closed');
  dc.onerror = (e) => console.error(`DC err: ${e}`);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const { sdp } = offer;
  if (typeof sdp === 'string') {
    startCtrlClient(pc, sdp);
  } else {
    console.error('Invalid SDP:', sdp);
  }
});

async function startCtrlClient(
  pc: RTCPeerConnection,
  sdp: string
) {
  console.log('Starting Ctrl Client');
  const genUuid = () =>
    crypto?.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c == 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  const ctrlId = genUuid();

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      set(ref(db, `ctrlOffers/${ctrlId}/ice`), e.candidate.toJSON());
      console.log('ICE:', e.candidate.toJSON());
    }
  };

  try {
    await set(ref(db, `ctrlOffers/${ctrlId}/offer`), sdp);
  } catch (e) {
    console.error('Err set offer:', e);
    return;
  }

  const rmWaitRoom = async (id: string) => {
    try {
      await remove(ref(db, `waitingRooms/${id}`));
      console.log(`Del wait: ${id}`);
    } catch (e) {
      console.error(`Err del wait ${id}:`, e);
    }
  };

  try {
    console.log('Del exist waits');
    const snap = await get(ref(db, 'waitingRooms'));
    const removalPromises: Promise<void>[] = [];
    snap.forEach((s) => {
      removalPromises.push(rmWaitRoom(String(s.key)));
    });
    await Promise.all(removalPromises);
    console.log('Waits del');
  } catch (e) {
    console.error('Err del exist waits:', e);
  }

  // Re-inserting the waiting room creation logic:
  try {
    console.log(`Create wait: ${ctrlId}`);
    await set(ref(db, `waitingRooms/${ctrlId}`), true);
    console.log(`Wait created: ${ctrlId}`);
  } catch (e) {
    console.error(`Err create wait:`, e);
  }

  const rmOffer = async (id: string) => {
    if (id === ctrlId) return;
    try {
      await remove(ref(db, `ctrlOffers/${id}`));
      console.log(`Del offer: ${id}`);
    } catch (e) {
      console.error(`Err del offer ${id}:`, e);
    }
  };

  try {
    console.log('Del exist offers');
    const snap = await get(ref(db, 'ctrlOffers'));
    const deletionPromises: Promise<void>[] = [];
    snap.forEach((s) => {
      if (s.key !== ctrlId) {
        deletionPromises.push(rmOffer(s.key));
      }
    });
    await Promise.all(deletionPromises);
    console.log('Offers del');
  } catch (e) {
    console.error('Err del exist offers:', e);
  }

  onValue(ref(db, `ctrlOffers/${ctrlId}/answer`), async (snap) => {
    const ans = snap.val();
    if (ans) {
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: ans });
        console.log('Remote desc set (ctrl)');
      } catch (e) {
        console.error('Err set remote desc (ctrl):', e);
      }
    }
  });

  onValue(ref(db, `ctrlOffers/${ctrlId}/synthIce`), async (snap) => {
    const ice = snap.val();
    if (ice) {
      try {
        await pc.addIceCandidate(ice);
        console.log('ICE added (ctrl):', ice);
      } catch (e) {
        console.error('Err add ICE (ctrl):', e);
      }
    }
  });
}
</script>
<!-- <link rel="stylesheet" href="src/app.css"> -->
<h1 class="text-3xl font-bold underline">ACTIVE</h1>