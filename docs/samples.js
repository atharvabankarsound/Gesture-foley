// Sample engine: holds your recorded sounds for each folder (category) and finger slot.
//
// - Several samples per slot play in random order, never the same one twice in a row
//   (round-robin), so repeated steps don't sound like a machine gun.
// - Velocity sets loudness and brightness (softer touch = quieter and darker).
// - Variation adds small random pitch and level changes.
// - Samples you add are saved in this browser (IndexedDB), so they are still there next time.
// - A bundled pack can live in docs/samples/ with a manifest.json; it loads for everyone.

import { A } from "./sounds.js";

const bank = {};          // "cat/slot" -> [{id, name, buffer, saved}]
const lastPick = {};
const key = (cat, slot) => `${cat}/${slot}`;
export const AUDIO_EXT = /\.(wav|wave|mp3|aif|aiff|flac|ogg|oga|m4a|aac|caf|webm)$/i;
const MAX_BYTES = 30 * 1024 * 1024;

/* ---------------------------------------------------------- IndexedDB */

const DB_NAME = "gesture-foley", STORE = "samples";
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);   // private windows / blocked storage: run without saving
  }
  return dbPromise;
}

async function dbRun(mode, fn) {
  try {
    const db = await openDB();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    return null;
  }
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/* ------------------------------------------------------------ loading */

async function decode(arrayBuffer) {
  // decodeAudioData detaches the buffer it is given, so pass a copy and keep the original for saving.
  return A.ctx.decodeAudioData(arrayBuffer.slice(0));
}

/**
 * Add audio files to one slot.
 * @returns {added, failed: [{name, reason}]}
 */
export async function addFiles(cat, slot, files) {
  const failed = [];
  let added = 0;
  for (const f of files) {
    if (!(f.type || "").startsWith("audio/") && !AUDIO_EXT.test(f.name)) { failed.push({ name: f.name, reason: "not an audio file" }); continue; }
    if (f.size > MAX_BYTES) { failed.push({ name: f.name, reason: "larger than 30 MB" }); continue; }
    try {
      const data = await f.arrayBuffer();
      const buffer = await decode(data);
      const id = newId();
      (bank[key(cat, slot)] ||= []).push({ id, name: f.name, buffer, saved: true });
      await dbRun("readwrite", (s) => s.put({ id, cat, slot, name: f.name, data }));
      added++;
    } catch {
      failed.push({ name: f.name, reason: "this browser can't read that format" });
    }
  }
  return { added, failed };
}

/** Reload samples saved in this browser. */
export async function restore() {
  const all = (await dbRun("readonly", (s) => s.getAll())) || [];
  let n = 0;
  for (const rec of all) {
    try {
      const buffer = await decode(rec.data);
      (bank[key(rec.cat, rec.slot)] ||= []).push({ id: rec.id, name: rec.name, buffer, saved: true });
      n++;
    } catch { /* skip files that no longer decode */ }
  }
  return n;
}

/** Load the bundled pack from samples/manifest.json, if the repo has one. */
export async function loadBundled(base = "samples/") {
  let manifest;
  try {
    const res = await fetch(base + "manifest.json", { cache: "no-cache" });
    if (!res.ok) return 0;
    manifest = await res.json();
  } catch {
    return 0;
  }
  let n = 0;
  const jobs = [];
  for (const [cat, slots] of Object.entries(manifest)) {
    for (const [slot, paths] of Object.entries(slots)) {
      for (const p of paths) {
        jobs.push((async () => {
          try {
            const res = await fetch(base + p);
            if (!res.ok) return;
            const buffer = await decode(await res.arrayBuffer());
            (bank[key(cat, slot)] ||= []).push({ id: "bundled:" + p, name: p.split("/").pop(), buffer, saved: false });
            n++;
          } catch { /* skip */ }
        })());
      }
    }
  }
  await Promise.all(jobs);
  return n;
}

/* ---------------------------------------------------------- managing */

export function list(cat, slot) { return bank[key(cat, slot)] || []; }
export function count(cat, slot) { return list(cat, slot).length; }

export async function clearSlot(cat, slot) {
  const items = list(cat, slot);
  for (const it of items) if (it.saved) await dbRun("readwrite", (s) => s.delete(it.id));
  delete bank[key(cat, slot)];
}

export async function clearAll() {
  await dbRun("readwrite", (s) => s.clear());
  for (const k of Object.keys(bank)) delete bank[k];
}

/* ----------------------------------------------------------- playback */

/**
 * Play one sample from a slot.
 * @param vel        0..1 loudness/brightness
 * @param pan        -1..1
 * @param variation  0..1 random pitch (up to ±1.5 semitones) and level (up to ±1.5 dB)
 * @returns the sample's name, or null if the slot is empty
 */
export function play(cat, slot, vel, pan, variation) {
  const items = list(cat, slot);
  if (!items.length || !A.ctx) return null;
  const k = key(cat, slot);
  let i = Math.floor(Math.random() * items.length);
  if (items.length > 1 && i === lastPick[k]) i = (i + 1) % items.length;
  lastPick[k] = i;

  const ctx = A.ctx, t = ctx.currentTime + 0.002;
  const r = () => Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = items[i].buffer;
  src.playbackRate.value = Math.pow(2, (r() * variation * 1.5) / 12);

  const tone = ctx.createBiquadFilter();       // softer touches sound darker, like a lighter footfall
  tone.type = "lowpass";
  tone.frequency.value = Math.min(20000, 1800 + 18200 * Math.pow(vel, 1.6));
  tone.Q.value = 0.5;

  const g = ctx.createGain();
  g.gain.value = (0.16 + 0.84 * Math.pow(vel, 1.3)) * Math.pow(10, (r() * variation * 1.5) / 20);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;

  src.connect(tone).connect(g).connect(p).connect(A.bus);
  src.onended = () => p.disconnect();
  src.start(t);
  return items[i].name;
}
