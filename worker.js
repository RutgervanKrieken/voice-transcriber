// Runs Whisper in the browser. Audio never leaves the device; only the model
// files are downloaded (once, then cached by the browser).
import * as T from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

T.env.allowLocalModels = false;
// Later, to host the model files on SharePoint instead of Hugging Face:
// T.env.remoteHost = 'https://<tenant>.sharepoint.com/sites/<site>/models/';

const MODELS = {
  small: 'onnx-community/whisper-small',
  turbo: 'onnx-community/whisper-large-v3-turbo',
};

let transcriber = null;
let loadedKey = null;

// Download size in MB per model and variant, so progress can show the real total
// from the start (files begin downloading one after another).
const SIZES = {
  small: { fp16: 410, fp32: 586, cpu: 249 },
  turbo: { fp16: 1608 },
};

async function gpuInfo() {
  try {
    const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
    return adapter ? { f16: adapter.features.has('shader-f16') } : null;
  } catch {
    return null;
  }
}

async function load(key) {
  if (transcriber && loadedKey === key) return;
  const gpu = await gpuInfo();
  // Full-precision large model (2.5 GB external-data file) hangs in transformers.js
  // 3.0.2, so the large model needs half-precision GPU support.
  if (key === 'turbo' && !gpu?.f16) {
    throw new Error('Het grote model werkt niet op deze computer (de videokaart ondersteunt geen WebGPU met halve precisie). Kies het kleine model.');
  }
  const device = gpu ? 'webgpu' : 'wasm';
  // The encoder is most of the download: half precision halves it where the GPU
  // supports it. The decoder is 4-bit on GPU; on CPU both are 8-bit.
  const variant = !gpu ? 'cpu' : gpu.f16 ? 'fp16' : 'fp32';
  const dtype = {
    cpu: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    fp16: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
    fp32: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  }[variant];
  const expected = (SIZES[key][variant] ?? 0) * 1e6;

  const files = {};
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files[p.file] = { loaded: p.loaded, total: p.total };
      const all = Object.values(files);
      const loaded = all.reduce((s, f) => s + f.loaded, 0);
      const total = Math.max(expected, all.reduce((s, f) => s + f.total, 0));
      self.postMessage({ type: 'load-progress', loaded, total });
    }
  };

  if (transcriber) await transcriber.dispose?.();
  transcriber = null;
  transcriber = await T.pipeline('automatic-speech-recognition', MODELS[key], {
    device, dtype, progress_callback,
  });
  loadedKey = key;
  self.postMessage({ type: 'loaded', device });
}

const SR = 16000;

function rms(a) {
  let e = 0;
  for (let i = 0; i < a.length; i += 4) e += a[i] * a[i];
  return Math.sqrt(e / Math.ceil(a.length / 4));
}

// `windows` are ≤30 s pieces cut at quiet moments by the app, so each is one
// Whisper pass and nothing needs to be stitched together.
async function transcribe(audio, windows) {
  const chunks = [];
  for (const w of windows) {
    const part = audio.subarray(w.s, w.e);
    // Skip silence: Whisper invents text ("Ondertiteling door…") on empty audio.
    if (rms(part) < 0.0005) continue;
    // Live preview while it works; the final result replaces it.
    const streamer = T.WhisperTextStreamer
      ? new T.WhisperTextStreamer(transcriber.tokenizer, {
          callback_function: (text) => self.postMessage({ type: 'partial', text }),
        })
      : undefined;
    const out = await transcriber(part, {
      language: 'dutch',
      task: 'transcribe',
      return_timestamps: true,
      streamer,
    });
    const off = w.s / SR, dur = (w.e - w.s) / SR;
    for (const c of out.chunks?.length ? out.chunks : [{ timestamp: [0, dur], text: out.text }]) {
      chunks.push({ timestamp: [off + (c.timestamp[0] ?? 0), off + (c.timestamp[1] ?? dur)], text: c.text });
    }
  }
  self.postMessage({ type: 'result', chunks });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load(data.model);
    } else if (data.type === 'transcribe') {
      await load(data.model);
      await transcribe(data.audio, data.windows);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
