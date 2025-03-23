import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
// import { getStorage } from 'firebase/storage'
import { onAuthStateChanged } from 'firebase/auth'
import { writable } from 'svelte/store'
import type { User } from 'firebase/auth'
import { getDatabase } from 'firebase/database'

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAFw1rGC749T8tCqLiVRrOcaDa2jTSrKRs",
  authDomain: "distributedsynthesis.firebaseapp.com",
  projectId: "distributedsynthesis",
  // storageBucket: "distributedsynthesis.firebasestorage.app",
  messagingSenderId: "654241099583",
  appId: "1:654241099583:web:e10da6d228d516f9acad8a",
  databaseURL: "https://distributedsynthesis-default-rtdb.asia-southeast1.firebasedatabase.app",
};

// Initialize Firebase
export const app = initializeApp (firebaseConfig)
console.log ('Firebase initialized')
// export const db = getFirestore ()
export const db = getDatabase (app)
// console.dir (db)

export const auth = getAuth ()
// export const storage = getStorage ()

function userStore() {
  let unsubscribe: () => void

  if (!auth || !globalThis.window) {
    console.warn ('Auth is not initialized or not in browser')
    const { subscribe } = writable<User | null> (null)
    return { subscribe }
  }

  const { subscribe } = writable (auth?.currentUser ?? null, set => {
    unsubscribe = onAuthStateChanged (auth, (user) => {
      set (user)
    })

    return () => unsubscribe ()
  })

  return { subscribe }
}

export const user = userStore ()

