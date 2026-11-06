// Storage adapters with one interface:
//   watch(cb) → unsubscribe   cb({profile, accounts, clients, incomes, expenses, payments, events})
//   setProfile(patch) · add(col, data) · update(col, id, patch) · remove(col, id) · put(col, id, data)
//
// CloudStore — Firestore under users/{uid}/…, with a persistent local cache:
// works offline, syncs across devices when online.
// LocalStore — localStorage, for running without Firebase.

import { FIREBASE_CONFIG } from './config.js';

export const COLLECTIONS = ['accounts', 'clients', 'recurring', 'incomes', 'expenses', 'payments', 'events'];
const SDK = 'https://www.gstatic.com/firebasejs/11.10.0';

export const cloudConfigured = () => Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);

// ───────────────────────── local ─────────────────────────
const LS_KEY = 'astro-tax/v1';

export class LocalStore {
  mode = 'local';
  #listeners = new Set();
  #state;

  constructor() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY)); } catch { /* empty */ }
    this.#state = { profile: {}, ...Object.fromEntries(COLLECTIONS.map((c) => [c, []])), ...saved };
  }

  #emit() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.#state)); } catch { /* quota / private mode */ }
    const snap = structuredClone(this.#state);
    this.#listeners.forEach((cb) => cb(snap));
  }

  watch(cb) {
    this.#listeners.add(cb);
    cb(structuredClone(this.#state));
    return () => this.#listeners.delete(cb);
  }

  async setProfile(patch) { this.#state.profile = { ...this.#state.profile, ...patch }; this.#emit(); }
  // Receipts are big (image data URLs) — kept apart from the watched state.
  async saveReceipt(id, r) { localStorage.setItem(`${LS_KEY}/receipt/${id}`, JSON.stringify(r)); }
  async loadReceipt(id) { try { return JSON.parse(localStorage.getItem(`${LS_KEY}/receipt/${id}`)); } catch { return null; } }
  async deleteReceipt(id) { localStorage.removeItem(`${LS_KEY}/receipt/${id}`); }
  async add(col, data) { this.#state[col].push({ id: crypto.randomUUID(), ...data }); this.#emit(); }
  async put(col, id, data) {
    const list = this.#state[col];
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = { id, ...data }; else list.push({ id, ...data });
    this.#emit();
  }
  async update(col, id, patch) {
    const item = this.#state[col].find((x) => x.id === id);
    if (item) Object.assign(item, patch);
    this.#emit();
  }
  async remove(col, id) { this.#state[col] = this.#state[col].filter((x) => x.id !== id); this.#emit(); }
}

// ───────────────────────── cloud ─────────────────────────
let fb = null;
async function sdk() {
  if (fb) return fb;
  const [app, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const a = app.initializeApp(FIREBASE_CONFIG);
  const db = fs.initializeFirestore(a, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  fb = { auth, fs, authInstance: auth.getAuth(a), db };
  return fb;
}

/** Calls cb(user|null) on every sign-in / sign-out. */
export async function watchAuth(cb) {
  const { auth, authInstance } = await sdk();
  return auth.onAuthStateChanged(authInstance, (user) => cb(user));
}

export async function signIn() {
  const { auth, authInstance } = await sdk();
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await auth.signInWithPopup(authInstance, provider);
}

export async function signOut() {
  const { auth, authInstance } = await sdk();
  await auth.signOut(authInstance);
}

export class CloudStore {
  mode = 'cloud';
  constructor(uid) { this.uid = uid; }

  #ref(...path) { return fb.fs.doc(fb.db, 'users', this.uid, ...path); }
  #col(name) { return fb.fs.collection(fb.db, 'users', this.uid, name); }

  watch(cb) {
    const { fs } = fb;
    const state = { profile: {}, ...Object.fromEntries(COLLECTIONS.map((c) => [c, []])) };
    const ready = new Set();
    const total = COLLECTIONS.length + 1;
    const emit = (key, pending) => {
      ready.add(key);
      state.pending = pending;
      if (ready.size === total) cb(structuredClone(state));
    };
    const unsubs = [
      fs.onSnapshot(this.#ref(), { includeMetadataChanges: true }, (s) => {
        state.profile = s.data() ?? {};
        emit('profile', s.metadata.hasPendingWrites);
      }, (e) => cb(null, e)),
      ...COLLECTIONS.map((c) => fs.onSnapshot(this.#col(c), { includeMetadataChanges: true }, (s) => {
        state[c] = s.docs.map((d) => ({ id: d.id, ...d.data() }));
        emit(c, s.metadata.hasPendingWrites);
      }, (e) => cb(null, e))),
    ];
    return () => unsubs.forEach((u) => u());
  }

  setProfile(patch) { return fb.fs.setDoc(this.#ref(), patch, { merge: true }); }
  // users/{uid}/receipts/{expenseId} — not watched; loaded on demand (≤1 MiB per doc).
  saveReceipt(id, r) { return fb.fs.setDoc(this.#ref('receipts', id), r); }
  async loadReceipt(id) { const s = await fb.fs.getDoc(this.#ref('receipts', id)); return s.exists() ? s.data() : null; }
  deleteReceipt(id) { return fb.fs.deleteDoc(this.#ref('receipts', id)); }
  add(col, data) { return fb.fs.addDoc(this.#col(col), data); }
  put(col, id, data) { return fb.fs.setDoc(this.#ref(col, id), data); }
  update(col, id, patch) { return fb.fs.updateDoc(this.#ref(col, id), patch); }
  remove(col, id) { return fb.fs.deleteDoc(this.#ref(col, id)); }
}

export async function initCloud() { await sdk(); }
