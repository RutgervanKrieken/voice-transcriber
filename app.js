import { SR, decodeFile, planSegments, planWindows, int16ToFloat, startPcmCapture } from './audio.js';
import * as store from './store.js';
import { cleanChunks } from './clean.js';
import { PROMPTS, buildMessages } from './copilot.js';

const $ = (id) => document.getElementById(id);
const els = {
  recBtn: $('recBtn'), recLabel: $('recLabel'), timer: $('timer'), level: $('level'),
  fileInput: $('fileInput'), player: $('player'), model: $('model'),
  engineBrowser: $('engineBrowser'), engineBackend: $('engineBackend'), backendUrl: $('backendUrl'),
  transcribeBtn: $('transcribeBtn'), progress: $('progress'), status: $('status'),
  timestamps: $('timestamps'), clean: $('clean'), transcript: $('transcript'),
  copyBtn: $('copyBtn'), txtBtn: $('txtBtn'), audioBtn: $('audioBtn'),
  summaryType: $('summaryType'), copilotBtn: $('copilotBtn'), copilotStatus: $('copilotStatus'),
  copilotSteps: $('copilotSteps'), history: $('history'), historyEmpty: $('historyEmpty'),
  resumeBanner: $('resumeBanner'), resumeText: $('resumeText'), resumeBtn: $('resumeBtn'),
  secureNote: $('secureNote'), clearBtn: $('clearBtn'), stopBtn: $('stopBtn'),
};

const MAX_STORED_AUDIO = 500 * 1024 * 1024; // bigger uploads must be re-selected to resume

let audioBlob = null;      // current recording or uploaded file
let pcm = null;            // 16 kHz mono Int16 samples, when already known
let job = null;            // current job, saved in IndexedDB as work progresses
let busy = false;
let pendingResume = null;  // job waiting for the user to re-select its file

if (!window.isSecureContext) els.secureNote.hidden = false;

// The large model is the default, but needs WebGPU with half precision.
// Without it, fall back to the small model so nobody starts with an error.
(async () => {
  let f16 = false;
  try {
    const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
    f16 = !!adapter?.features.has('shader-f16');
  } catch {}
  if (f16) return;
  const turbo = els.model.querySelector('option[value="turbo"]');
  turbo.disabled = true;
  turbo.textContent = 'Model: groot (werkt niet op deze computer)';
  els.model.value = 'small';
})();
navigator.storage?.persist?.().catch(() => {});

function onEngineChange() {
  const backend = els.engineBackend.checked;
  els.model.hidden = backend;
  els.backendUrl.hidden = !backend;
}
els.engineBrowser.onchange = els.engineBackend.onchange = onEngineChange;

// ---------- Helpers ----------
function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

function fmtEta(s) {
  if (s < 60) return 'minder dan een minuut';
  const m = Math.round(s / 60);
  return m < 60 ? `ca. ${m} min` : `ca. ${Math.floor(m / 60)} u ${m % 60} min`;
}

function newJob(name) {
  return {
    id: crypto.randomUUID(), name, createdAt: Date.now(), status: 'ready',
    duration: 0, segTotal: 0, segDone: 0, chunks: [], editedText: null,
    hasAudio: false, file: null,
  };
}

const saveJob = (j) => store.safe(store.put('jobs', structuredClone(j)));

function setAudio(blob, name) {
  audioBlob = blob;
  if (els.player.src) URL.revokeObjectURL(els.player.src);
  els.player.src = URL.createObjectURL(blob);
  els.player.hidden = false;
  els.audioBtn.disabled = false;
  els.transcribeBtn.disabled = busy;
  if (job) job.name = name;
}

function clearAudio() {
  audioBlob = null;
  pcm = null;
  els.player.hidden = true;
  els.player.removeAttribute('src');
  els.audioBtn.disabled = true;
  els.transcribeBtn.disabled = true;
}

// Keep the screen (and so the laptop) awake while transcribing.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock) {
      wakeLock = await navigator.wakeLock?.request('screen');
      wakeLock?.addEventListener('release', () => (wakeLock = null));
    } else if (!on) {
      await wakeLock?.release();
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (busy && document.visibilityState === 'visible') keepAwake(true);
});

// ---------- Recording ----------
let recorder = null, stream = null, capture = null, recChunks = [], recSeq = 0;
let timerId = null, rafId = null, meterCtx = null;

async function startRecording() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    setStatus(`Geen toegang tot de microfoon: ${err.message}`, true);
    return;
  }
  clearAudio();
  job = newJob(`opname-${stamp()}`);
  job.status = 'recording';
  await saveJob(job);
  renderTranscript();
  refreshHistory();

  const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
    .find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  recChunks = [];
  recSeq = 0;
  const recJobId = job.id;
  // Every second goes to IndexedDB too, so a crash or closed tab keeps the recording.
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    recChunks.push(e.data);
    store.safe(store.put('recparts', e.data, store.partKey(recJobId, recSeq++)));
  };
  recorder.start(1000);

  // 16 kHz samples straight from the mic, so long recordings need no decoding.
  capture = await startPcmCapture(stream);
  let analyser = capture?.analyser;
  if (!analyser) {
    meterCtx = new AudioContext();
    analyser = meterCtx.createAnalyser();
    analyser.fftSize = 512;
    meterCtx.createMediaStreamSource(stream).connect(analyser);
  }

  const started = Date.now();
  els.timer.textContent = '0:00';
  timerId = setInterval(() => (els.timer.textContent = fmtTime((Date.now() - started) / 1000)), 250);
  const buf = new Uint8Array(analyser.fftSize);
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    els.level.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
    rafId = requestAnimationFrame(tick);
  };
  tick();

  els.recBtn.classList.add('recording');
  els.recLabel.textContent = 'Stoppen';
  els.fileInput.disabled = true;
  els.clearBtn.disabled = true;
  setStatus('Bezig met opnemen… de opname wordt tussentijds bewaard.');
}

async function stopRecording() {
  els.recBtn.disabled = true;
  const stopped = new Promise((r) => recorder.addEventListener('stop', r, { once: true }));
  recorder.stop();
  const captured = capture ? await capture.stop() : null;
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  clearInterval(timerId);
  cancelAnimationFrame(rafId);
  meterCtx?.close();
  meterCtx = capture = null;
  els.level.style.width = '0';
  els.recBtn.classList.remove('recording');
  els.recLabel.textContent = 'Opnemen';
  els.recBtn.disabled = false;
  els.fileInput.disabled = false;
  els.clearBtn.disabled = false;

  const blob = new Blob(recChunks, { type: recorder.mimeType });
  recChunks = [];
  setAudio(blob, job.name);
  pcm = captured?.length ? captured : null;
  job.status = 'ready';
  job.hasAudio = !!(await store.safe(store.put('audio', blob, job.id).then(() => true), false));
  await saveJob(job);
  if (job.hasAudio) store.safe(store.delParts(job.id));
  refreshHistory();
  setStatus('Opname klaar. Klik op Uitschrijven.');
}

els.recBtn.onclick = () => (recorder?.state === 'recording' ? stopRecording() : startRecording());

window.addEventListener('beforeunload', (e) => {
  if (recorder?.state === 'recording' || busy) e.preventDefault();
});

// ---------- Upload ----------
els.fileInput.onchange = async () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = '';
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '');

  if (pendingResume) {
    const j = pendingResume;
    pendingResume = null;
    const same = j.file && j.file.name === file.name && j.file.size === file.size;
    if (!same && !confirm('Dit lijkt een ander bestand dan het oorspronkelijke. Toch verdergaan?')) return;
    job = j;
    pcm = null;
    setAudio(file, j.name);
    startTranscription();
    return;
  }

  job = null;
  pcm = null;
  setAudio(file, name);
  els.transcript.value = '';
  setStatus(`"${file.name}" geladen. Klik op Uitschrijven.`);
};

// ---------- Transcription (worker) ----------
let worker = null;
let pending = null, partial = '', device = '', loadedAt = 0, stopRequested = false;

function onWorkerMessage({ data }) {
  switch (data.type) {
    case 'load-progress': {
      const mb = (n) => Math.round(n / 1e6);
      setStatus(`Model laden… ${mb(data.loaded)} / ${mb(data.total)} MB (de eerste keer wordt het gedownload)`);
      break;
    }
    case 'loaded':
      device = data.device === 'webgpu' ? 'GPU' : 'CPU';
      loadedAt = performance.now();
      break;
    case 'partial':
      partial += data.text;
      renderTranscript(partial);
      break;
    case 'result':
      pending?.resolve(data);
      pending = null;
      break;
    case 'error':
      pending?.reject(new Error(data.message));
      pending = null;
      break;
  }
}

function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  // A worker crash (e.g. out of memory) must not leave the app waiting forever.
  worker.onerror = (e) => {
    e.preventDefault();
    pending?.reject(new Error(e.message || 'het spraakmodel is gestopt (mogelijk te weinig geheugen)'));
    pending = null;
  };
}
startWorker();

class Stopped extends Error {}

// Stopping kills the worker mid-segment; the next run reloads the model from
// the browser cache. Work up to the last finished segment is already saved.
els.stopBtn.onclick = () => {
  if (!busy) return;
  stopRequested = true;
  els.stopBtn.disabled = true;
  worker.terminate();
  pending?.reject(new Stopped());
  pending = null;
  startWorker();
};

function transcribeSegment(start, end, model) {
  partial = '';
  const audio = int16ToFloat(pcm.subarray(start, end));
  if (els.engineBackend.checked) {
    const url = els.backendUrl.value.replace(/\/$/, '');
    return fetch(`${url}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': String(SR) },
      body: audio.buffer,
    }).then(async (r) => {
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `serverfout (${r.status})`);
      }
      return r.json();
    });
  }
  const windows = planWindows(pcm, start, end).map((w) => ({ s: w.start - start, e: w.end - start }));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    worker.postMessage({ type: 'transcribe', model, audio, windows }, [audio.buffer]);
  });
}

// Transcribes in ~5 minute segments and saves after each one, so progress
// survives a crash or closed tab and can be resumed from the last segment.
async function startTranscription() {
  if (!audioBlob || busy) return;
  if (job?.status === 'done') {
    if (!confirm('Opnieuw uitschrijven? De huidige tekst wordt vervangen.')) return;
    Object.assign(job, { segTotal: 0, segDone: 0, chunks: [], editedText: null });
  }
  busy = true;
  stopRequested = false;
  setBusyUi(true);
  keepAwake(true);
  const runStart = performance.now();
  try {
    if (els.engineBackend.checked) {
      const url = els.backendUrl.value.replace(/\/$/, '');
      try {
        const r = await fetch(`${url}/health`);
        if (!r.ok) throw new Error();
      } catch {
        throw new Error(`Kan de lokale server niet bereiken op ${url}. Controleer of deze draait.`);
      }
    }
    if (!job) {
      job = newJob(audioBlob.name ? audioBlob.name.replace(/\.[^.]+$/, '') : `opname-${stamp()}`);
      job.file = audioBlob.name ? { name: audioBlob.name, size: audioBlob.size } : null;
    }
    if (!job.hasAudio && audioBlob.size <= MAX_STORED_AUDIO) {
      job.hasAudio = !!(await store.safe(store.put('audio', audioBlob, job.id).then(() => true), false));
    }
    job.status = 'transcribing';
    await saveJob(job);
    refreshHistory();

    if (!pcm) {
      setStatus('Audio inlezen…');
      pcm = await decodeFile(audioBlob, (p) => setStatus(`Audio inlezen… ${Math.round(p * 100)}%`));
    }
    if (stopRequested) throw new Stopped();
    const segs = planSegments(pcm);
    if (job.segTotal && job.segTotal !== segs.length) Object.assign(job, { segDone: 0, chunks: [] });
    job.duration = pcm.length / SR;
    job.segTotal = segs.length;
    job.editedText = null;
    els.progress.max = job.duration;
    renderTranscript();

    const model = els.model.value;
    // Speed for the time estimate: transcription time only, not the model download.
    let workSec = 0, doneThisRun = 0;
    for (let i = job.segDone; i < segs.length; i++) {
      const { start, end } = segs[i];
      const offset = start / SR, segDur = (end - start) / SR;
      const doneSec = offset;
      els.progress.value = doneSec;
      const pct = Math.floor((doneSec / job.duration) * 100);
      const eta = doneThisRun > 0
        ? ` · nog ${fmtEta((workSec / doneThisRun) * (job.duration - doneSec))}`
        : i === job.segDone ? ' · resterende tijd wordt berekend…' : '';
      const where = els.engineBackend.checked ? ' op de lokale server' : device ? ` op ${device}` : '';
      setStatus(`Bezig met uitschrijven${where}… ${pct}% · deel ${i + 1} van ${segs.length}${eta}`);

      const segStart = performance.now();
      const res = await transcribeSegment(start, end, model);
      workSec += (performance.now() - Math.max(segStart, loadedAt)) / 1000;
      for (const c of res.chunks) {
        job.chunks.push({ start: offset + c.timestamp[0], end: offset + c.timestamp[1], text: c.text });
      }
      job.segDone = i + 1;
      await saveJob(job);
      partial = '';
      renderTranscript();
      doneThisRun += segDur;
    }

    job.status = 'done';
    await saveJob(job);
    const { removed } = cleanChunks(job.chunks);
    setStatus(`Klaar in ${fmtTime((performance.now() - runStart) / 1000)}.` +
      (removed ? ` ${removed} herhaling(en) of onzinzinnen gevonden.` : '') +
      ' Controleer de tekst; aanpassingen worden automatisch bewaard.');
  } catch (err) {
    if (err instanceof Stopped) {
      partial = '';
      renderTranscript();
      const pct = Math.floor(((job?.segDone ?? 0) / Math.max(1, job?.segTotal ?? 1)) * 100);
      setStatus(`Gestopt bij ${pct}%. Klik op Uitschrijven of Verdergaan om later verder te gaan.`);
    } else {
      setStatus(`Fout: ${err.message}. De voortgang tot nu toe is bewaard; je kunt later verdergaan.`, true);
    }
  } finally {
    busy = false;
    setBusyUi(false);
    keepAwake(false);
    refreshHistory();
  }
}

function setBusyUi(on) {
  els.clearBtn.disabled = on;
  els.stopBtn.hidden = !on;
  els.stopBtn.disabled = false;
  els.transcribeBtn.hidden = on;
  els.transcribeBtn.disabled = on || !audioBlob;
  els.recBtn.disabled = on;
  els.fileInput.disabled = on;
  els.transcript.readOnly = on;
  els.progress.hidden = !on;
  if (on) els.progress.removeAttribute('value');
}

els.transcribeBtn.onclick = () => startTranscription();

// ---------- Transcript display ----------
function formatChunks(chunks, withTimes) {
  if (withTimes) return chunks.map((c) => `[${fmtTime(c.start)}] ${c.text.trim()}`).join('\n');
  // Paragraphs at pauses, or after a minute of continuous speech at a sentence end.
  let out = '', paraStart = 0, prevEnd = 0;
  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    if (!out) {
      paraStart = c.start;
    } else if (c.start - prevEnd > 1.5 || (c.start - paraStart > 60 && /[.!?]$/.test(out))) {
      out += '\n\n';
      paraStart = c.start;
    } else {
      out += ' ';
    }
    out += text;
    prevEnd = c.end;
  }
  return out;
}

function renderTranscript(live = '') {
  if (!job) return;
  if (job.editedText != null && !busy) {
    els.transcript.value = job.editedText;
    return;
  }
  const chunks = els.clean.checked ? cleanChunks(job.chunks).chunks : job.chunks;
  let text = formatChunks(chunks, els.timestamps.checked);
  if (live.trim()) text += `${text ? '\n\n' : ''}${live.trim()} …`;
  els.transcript.value = text;
  if (busy) els.transcript.scrollTop = els.transcript.scrollHeight;
}

let saveTimer = null;
els.transcript.oninput = () => {
  if (!job || busy) return;
  job.editedText = els.transcript.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJob(job), 500);
};

function onDisplayOption() {
  if (job?.editedText != null) {
    if (!confirm('Je eigen aanpassingen in de tekst gaan hierdoor verloren. Doorgaan?')) {
      this.checked = !this.checked;
      return;
    }
    job.editedText = null;
    saveJob(job);
  }
  renderTranscript(partial);
}
els.timestamps.onchange = onDisplayOption;
els.clean.onchange = onDisplayOption;

// ---------- Clear ----------
// Empties the screen for a new recording. The job itself stays in the history.
const copilotHint = els.copilotStatus.textContent;
els.clearBtn.onclick = () => {
  if (busy || recorder?.state === 'recording') return;
  if (job && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveJob(job);
  }
  job = null;
  pendingResume = null;
  partial = '';
  clearAudio();
  els.transcript.value = '';
  els.timer.textContent = '0:00';
  els.copilotSteps.hidden = true;
  els.copilotSteps.replaceChildren();
  els.copilotStatus.textContent = copilotHint;
  setStatus('Leeggemaakt. Eerdere opnames staan onder "Bewaard in deze browser".');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ---------- Saved jobs ----------
function statusLabel(j) {
  switch (j.status) {
    case 'recording': return 'Opname onderbroken (hersteld)';
    case 'ready': return 'Nog niet uitgeschreven';
    case 'transcribing': return `Onderbroken bij ${Math.floor((j.segDone / Math.max(1, j.segTotal)) * 100)}%`;
    case 'done': return `Uitgeschreven · ${fmtTime(j.duration)}`;
    default: return '';
  }
}

async function refreshHistory() {
  const jobs = (await store.safe(store.all('jobs'), [])).sort((a, b) => b.createdAt - a.createdAt);
  els.history.replaceChildren();
  els.historyEmpty.hidden = jobs.length > 0;
  for (const j of jobs) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = j.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${new Date(j.createdAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })} · ${statusLabel(j)}`;
    name.append(meta);
    li.append(name);
    const isCurrent = busy && job?.id === j.id;
    const add = (label, fn, primary = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.disabled = busy || recorder?.state === 'recording';
      if (primary) b.className = 'primary';
      b.onclick = fn;
      li.append(b);
    };
    if (isCurrent) {
      const m = document.createElement('span');
      m.className = 'meta';
      m.textContent = 'Bezig…';
      li.append(m);
    } else {
      add('Openen', () => openJob(j));
      if (j.status === 'transcribing' || j.status === 'ready' || j.status === 'recording') {
        add(j.status === 'transcribing' ? 'Verdergaan' : 'Uitschrijven', () => resumeJob(j), true);
      }
      add('Verwijderen', () => deleteJob(j));
    }
    els.history.append(li);
  }
  const unfinished = jobs.find((j) => j.status === 'transcribing' && !(busy && job?.id === j.id));
  els.resumeBanner.hidden = !unfinished || busy;
  if (unfinished) {
    els.resumeText.textContent = `"${unfinished.name}" is niet helemaal uitgeschreven (${statusLabel(unfinished).toLowerCase()}).`;
    els.resumeBtn.onclick = () => resumeJob(unfinished);
  }
}

async function openJob(j) {
  job = j;
  pcm = null;
  const blob = j.hasAudio ? await store.safe(store.get('audio', j.id)) : null;
  if (blob) setAudio(blob, j.name);
  else clearAudio();
  renderTranscript();
  setStatus(blob || j.status === 'done' ? `"${j.name}" geopend.` : `"${j.name}" geopend. De audio is niet in de browser bewaard.`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function resumeJob(j) {
  await openJob(j);
  if (audioBlob) return startTranscription();
  pendingResume = j;
  setStatus(`Kies het oorspronkelijke bestand${j.file ? ` ("${j.file.name}")` : ''} opnieuw om verder te gaan.`);
  els.fileInput.click();
}

async function deleteJob(j) {
  if (!confirm(`"${j.name}" verwijderen uit deze browser? De tekst en audio zijn daarna weg.`)) return;
  await store.safe(store.del('jobs', j.id));
  await store.safe(store.del('audio', j.id));
  await store.safe(store.delParts(j.id));
  if (job?.id === j.id) {
    job = null;
    clearAudio();
    els.transcript.value = '';
  }
  refreshHistory();
}

// A recording whose tab crashed or closed: rebuild the audio from saved parts.
async function recoverRecordings() {
  const jobs = await store.safe(store.all('jobs'), []);
  for (const j of jobs.filter((x) => x.status === 'recording')) {
    const parts = await store.safe(store.getParts(j.id), []);
    if (!parts.length) {
      await store.safe(store.del('jobs', j.id));
      continue;
    }
    const blob = new Blob(parts, { type: parts[0].type });
    j.hasAudio = !!(await store.safe(store.put('audio', blob, j.id).then(() => true), false));
    if (!j.hasAudio) continue;
    j.status = 'ready';
    j.name += ' (hersteld)';
    await saveJob(j);
    await store.safe(store.delParts(j.id));
  }
}

recoverRecordings().then(refreshHistory);

// ---------- Output ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function audioExt(blob) {
  if (blob.name) return blob.name.split('.').pop();
  return blob.type.includes('mp4') ? 'm4a' : 'webm';
}

const baseName = () => job?.name ?? (audioBlob?.name ? audioBlob.name.replace(/\.[^.]+$/, '') : 'opname');

els.copyBtn.onclick = async () => {
  await navigator.clipboard.writeText(els.transcript.value);
  setStatus('Gekopieerd naar het klembord.');
};
els.txtBtn.onclick = () =>
  download(new Blob([els.transcript.value], { type: 'text/plain;charset=utf-8' }), `${baseName()}.txt`);
els.audioBtn.onclick = () => audioBlob && download(audioBlob, `${baseName()}.${audioExt(audioBlob)}`);

// ---------- Summary via Copilot ----------
// Free Copilot Chat has no API: we copy the text and the user pastes it.
// Long transcripts become several messages for the same conversation.
const COPILOT_LINK = '<a href="https://m365.cloud.microsoft/chat" target="_blank" rel="noopener">Copilot Chat openen</a>';
const PASTE = 'druk op <kbd>Ctrl</kbd>+<kbd>V</kbd> (<kbd>⌘</kbd>+<kbd>V</kbd> op Mac)';

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function manualBox() {
  return `<details><summary>Plakken lukt niet? Kopieer de tekst hier handmatig</summary>
    <textarea readonly></textarea></details>`;
}

els.copilotBtn.onclick = async () => {
  const transcript = els.transcript.value.trim();
  const steps = els.copilotSteps;
  if (!transcript) {
    steps.hidden = true;
    els.copilotStatus.textContent = 'Er is nog geen tekst.';
    return;
  }
  els.copilotStatus.textContent = '';
  const messages = buildMessages(PROMPTS[els.summaryType.value], transcript);

  if (messages.length === 1) {
    const ok = await copy(messages[0]);
    steps.innerHTML = `<ol>
      <li>${ok ? '<strong>Tekst is gekopieerd</strong> naar het klembord.' : '<strong>Automatisch kopiëren lukte niet.</strong> Kopieer de tekst hieronder handmatig.'}</li>
      <li>Klik op ${COPILOT_LINK} (log in met je werkaccount).</li>
      <li>Klik in het berichtvak en ${PASTE}.</li>
      <li>Druk op <kbd>Enter</kbd> en wacht op de samenvatting.</li>
    </ol>${manualBox()}`;
    steps.querySelector('textarea').value = messages[0];
    steps.querySelector('details').open = !ok;
    steps.hidden = false;
    return;
  }

  steps.innerHTML = `<p style="margin:0 0 8px">De tekst is lang en wordt in <strong>${messages.length} delen</strong> verstuurd, allemaal in <strong>hetzelfde</strong> Copilot-gesprek.</p>
    <ol>
      <li>Klik op ${COPILOT_LINK} (log in met je werkaccount).</li>
      <li>Klik op <em>Deel 1 kopiëren</em>, ga naar Copilot, ${PASTE} en verstuur. Wacht tot Copilot antwoordt met “ontvangen”.</li>
      <li>Herhaal dit voor elk volgend deel.</li>
      <li>Na het laatste deel schrijft Copilot de samenvatting van het hele gesprek.</li>
    </ol>
    <div class="parts"></div>${manualBox()}`;
  const parts = steps.querySelector('.parts');
  const manual = steps.querySelector('textarea');
  messages.forEach((m, i) => {
    const b = document.createElement('button');
    b.textContent = `Deel ${i + 1} kopiëren`;
    b.onclick = async () => {
      manual.value = m;
      const ok = await copy(m);
      b.classList.toggle('done', ok);
      b.textContent = ok ? `✓ Deel ${i + 1} gekopieerd` : `Deel ${i + 1}: kopiëren mislukt`;
      steps.querySelector('details').open = !ok;
    };
    parts.append(b);
  });
  manual.value = messages[0];
  steps.hidden = false;
};
