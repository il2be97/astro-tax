// Firebase web config is public by design — the real lock is firestore.rules
// (each account sees only users/{its uid}/…).
// Paste the config of YOUR Firebase project (Project settings → Your apps → Web).
// While apiKey is empty the app runs in local mode (data only in this browser).
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDmz80OTBW830ij9PJkiqHSlLrQOq1xtDE',
  authDomain: 'astro-taxes.firebaseapp.com',
  projectId: 'astro-taxes',
  storageBucket: 'astro-taxes.firebasestorage.app',
  messagingSenderId: '138338534975',
  appId: '1:138338534975:web:64f5c9c4f2594b89129a8a',
};
