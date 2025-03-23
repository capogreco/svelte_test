import { initializeApp } from "firebase/app"
import { getAuth, onAuthStateChanged } from "firebase/auth"
import { w as writable } from "./exports.js"

const firebaseConfig = {
  apiKey: "AIzaSyAFw1rGC749T8tCqLiVRrOcaDa2jTSrKRs",
  authDomain: "distributedsynthesis.firebaseapp.com",
  projectId: "distributedsynthesis",
  storageBucket: "distributedsynthesis.firebasestorage.app",
  messagingSenderId: "654241099583",
  appId: "1:654241099583:web:e10da6d228d516f9acad8a"
};

initializeApp (firebaseConfig)

const auth = getAuth();
function userStore () {
  let unsubscribe;
  if (!auth || !globalThis.window) {
    console.warn("Auth is not initialized or not in browser");
    const { subscribe: subscribe2 } = writable(null);
    return { subscribe: subscribe2 };
  }
  const { subscribe } = writable(auth?.currentUser ?? null, (set) => {
    unsubscribe = onAuthStateChanged(auth, (user2) => {
      set(user2);
    });
    return () => unsubscribe();
  });
  return { subscribe };
}
const user = userStore();
export {
  user as u
};
