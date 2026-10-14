// Audio in, 16 kHz mono Int16 samples out. Int16 halves the memory of Float32:
// 90 minutes is ~170 MB.
export const SR = 16000;

const PIECE_BYTES = 16 * 1024 * 1024; // decode WAV/MP3 in pieces of this size
const SEGMENT_S = 300;                // transcribe and save per 5 minutes
const CUT_SEARCH_S = 15;              // look this far back for a quiet moment to cut

function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function int16ToFloat(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 0x8000;
  return out;
}

function concatInt16(parts) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// decodeAudioData on a 16 kHz context resamples for us; we only mix to mono.
async function decodeBytes(arrayBuffer) {
  let buf;
  try {
    // decodeAudioData detaches the buffer, so keep a copy for the retry.
    buf = await new OfflineAudioContext(1, 1, SR).decodeAudioData(arrayBuffer.slice(0));
  } catch {
    // Older Safari: decode through a regular AudioContext instead.
    const ctx = new AudioContext({ sampleRate: SR });
    try {
      buf = await ctx.decodeAudioData(arrayBuffer);
    } finally {
      ctx.close();
    }
  }
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  if (chs.length === 1) return floatToInt16(chs[0]);
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    let s = 0;
    for (const ch of chs) s += ch[i];
    s = Math.max(-1, Math.min(1, s / chs.length));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function sniff(blob) {
  const h = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const str = (a, b) => String.fromCharCode(...h.slice(a, b));
  if (str(0, 4) === 'RIFF' && str(8, 12) === 'WAVE') return 'wav';
  if (str(0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return 'mp3';
  return 'other';
}

// WAV: split the data chunk on frame boundaries and give each piece its own header.
async function wavPieces(blob) {
  const head = await blob.slice(0, 1 << 16).arrayBuffer();
  const v = new DataView(head);
  const id = (o) => String.fromCharCode(...new Uint8Array(head, o, 4));
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= head.byteLength) {
    const size = v.getUint32(off + 4, true);
    if (id(off) === 'fmt ') fmt = { bytes: new Uint8Array(head, off, 8 + size), blockAlign: v.getUint16(off + 20, true) };
    if (id(off) === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || dataOff < 0 || !fmt.blockAlign) return null;
  if (!dataLen || dataOff + dataLen > blob.size) dataLen = blob.size - dataOff;

  const step = PIECE_BYTES - (PIECE_BYTES % fmt.blockAlign);
  const pieces = [];
  for (let p = 0; p < dataLen; p += step) {
    const len = Math.min(step, dataLen - p);
    const hdr = new DataView(new ArrayBuffer(12));
    const riff = new Uint8Array(hdr.buffer);
    riff.set([82, 73, 70, 70]); // RIFF
    hdr.setUint32(4, 4 + fmt.bytes.length + 8 + len, true);
    riff.set([87, 65, 86, 69], 8); // WAVE
    const dataHdr = new DataView(new ArrayBuffer(8));
    new Uint8Array(dataHdr.buffer).set([100, 97, 116, 97]); // data
    dataHdr.setUint32(4, len, true);
    pieces.push(new Blob([riff, fmt.bytes, dataHdr, blob.slice(dataOff + p, dataOff + p + len)]));
  }
  return pieces;
}

// MPEG audio Layer III frame length in bytes at b[i], or 0 if no valid header.
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function frameLen(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
  if (ver === 1 || layer !== 1) return 0;
  const bi = b[i + 2] >> 4, si = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (bi === 0 || bi === 15 || si === 3) return 0;
  const kbps = (ver === 3 ? BITRATES_V1 : BITRATES_V2)[bi];
  return Math.floor(((ver === 3 ? 144000 : 72000) * kbps) / RATES[ver][si]) + pad;
}

// First frame start at or after pos: three headers in a row, so stray 0xFF bytes
// in audio data don't count.
async function nextFrame(blob, pos) {
  const b = new Uint8Array(await blob.slice(pos, pos + 64 * 1024).arrayBuffer());
  for (let i = 0; i + 4 < b.length; i++) {
    const a = frameLen(b, i);
    const c = a && i + a + 4 < b.length ? frameLen(b, i + a) : 0;
    if (c && i + a + c + 4 < b.length && frameLen(b, i + a + c)) return pos + i;
  }
  return -1;
}

// MP3: cut on frame boundaries so each piece is a valid stream on its own
// (Chrome tolerates arbitrary cuts, Safari does not).
async function mp3Pieces(blob) {
  const starts = [0];
  for (let p = PIECE_BYTES; blob.size - p > 1024 * 1024; p += PIECE_BYTES) {
    const f = await nextFrame(blob, p);
    if (f < 0) return null;
    starts.push(f);
  }
  return starts.map((s, i) => blob.slice(s, starts[i + 1] ?? blob.size));
}

export async function decodeFile(blob, onProgress = () => {}) {
  const kind = await sniff(blob);
  const pieces = kind === 'wav' ? await wavPieces(blob) : kind === 'mp3' ? await mp3Pieces(blob) : null;
  if (pieces) {
    try {
      const parts = [];
      for (let i = 0; i < pieces.length; i++) {
        onProgress(i / pieces.length);
        parts.push(await decodeBytes(await pieces[i].arrayBuffer()));
      }
      onProgress(1);
      return concatInt16(parts);
    } catch (err) {
      console.warn('Decoding in pieces failed, decoding whole file:', err);
    }
  }
  // Other formats (m4a, webm, mp4, …) and the fallback: decode the whole file.
  onProgress(0);
  return decodeBytes(await blob.arrayBuffer());
}

// Cut [from, to) into pieces of about `target` seconds, at the quietest moment
// in the `search` seconds before each boundary so words are not cut in half.
// No piece is longer than `maxLen` seconds.
function planCuts(pcm, { from = 0, to = pcm.length, target, search, maxLen }) {
  const win = SR / 4, hop = SR / 8;
  const cuts = [from];
  let pos = from;
  while (to - pos > maxLen * SR) {
    const end = pos + target * SR;
    let best = end, bestE = Infinity;
    for (let s = end - search * SR; s + win <= end; s += hop) {
      let e = 0;
      for (let i = s; i < s + win; i += 4) e += pcm[i] * pcm[i];
      if (e < bestE) { bestE = e; best = s + win / 2; }
    }
    cuts.push(best);
    pos = best;
  }
  cuts.push(to);
  return cuts.slice(1).map((end, i) => ({ start: cuts[i], end }));
}

// ~5 minute segments: the unit of saving and resuming.
export const planSegments = (pcm) =>
  planCuts(pcm, { target: SEGMENT_S, search: CUT_SEARCH_S, maxLen: SEGMENT_S + 30 });

// Whisper reads 30 s at a time. We cut those windows ourselves at quiet moments;
// letting transformers.js stitch overlapping windows lost or repeated sentences.
export const planWindows = (pcm, from, to) =>
  planCuts(pcm, { from, to, target: 27, search: 7, maxLen: 30 });

// Capture 16 kHz PCM straight from the microphone while recording. Returns null
// if the browser can't run a 16 kHz context on the mic; the app then decodes
// the recorded file afterwards instead.
export async function startPcmCapture(stream) {
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: SR });
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const parts = [];
    node.port.onmessage = (e) => parts.push(floatToInt16(e.data));
    await ctx.resume();
    return {
      analyser,
      async stop() {
        await ctx.close();
        return concatInt16(parts);
      },
    };
  } catch {
    ctx?.close();
    return null;
  }
}
