// Firebase web config is public by design — the real lock is firestore.rules
// (each account sees only users/{its uid}/…).
// Paste the config of YOUR Firebase project (Project settings → Your apps → Web).
// While apiKey is empty the app runs in local mode (data only in this browser).
export const FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};
