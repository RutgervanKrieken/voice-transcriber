// Local saving in the browser (IndexedDB): transcription progress, recordings
// while they are being made, and the audio of each job. Every call fails soft:
// without storage the app still works, it just can't resume.
const DB_NAME = 'spraak-naar-tekst';
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('jobs', { keyPath: 'id' });
      d.createObjectStore('audio');
      d.createObjectStore('recparts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const put = (store, value, key) => run(store, 'readwrite', (s) => s.put(value, key));
export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const all = (store) => run(store, 'readonly', (s) => s.getAll());
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

// Recording parts are keyed "<jobId>:<000001>" so they sort and can be fetched per job.
const range = (jobId) => IDBKeyRange.bound(`${jobId}:`, `${jobId}:￿`);
export const partKey = (jobId, seq) => `${jobId}:${String(seq).padStart(6, '0')}`;
export const getParts = (jobId) => run('recparts', 'readonly', (s) => s.getAll(range(jobId)));
export const delParts = (jobId) => run('recparts', 'readwrite', (s) => s.delete(range(jobId)));

export async function safe(promise, fallback = null) {
  try {
    return await promise;
  } catch (err) {
    console.warn('Opslag mislukt:', err);
    return fallback;
  }
}
