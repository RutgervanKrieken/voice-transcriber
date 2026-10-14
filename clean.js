// Removes Whisper's typical mistakes on long recordings: phrases repeated in a
// loop, the same segment twice in a row, and stock phrases it "hears" in silence
// (learned from Dutch subtitled video).
const HALLUCINATIONS = [
  /tv gelderland/,
  /amara ?org/,
  /^ondertitel(s|d|ing)? (door|van|ingediend)\b/,
  /^bedankt voor het kijken$/,
];

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

function dropHallucinations(text) {
  let removed = 0;
  const kept = text.split(/(?<=[.!?])\s+/).filter((sentence) => {
    const bad = HALLUCINATIONS.some((re) => re.test(norm(sentence)));
    if (bad) removed++;
    return !bad;
  });
  return { text: kept.join(' '), removed };
}

// Collapse a run of the same 1–15 word phrase to one occurrence. Single words
// need 4+ repeats ("nee nee nee" is normal speech), longer phrases 3+.
function collapseRepeats(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const key = words.map(norm);
  let removed = 0;
  for (let n = 1; n <= 15; n++) {
    const min = n === 1 ? 4 : 3;
    for (let i = 0; i + n * min <= key.length; i++) {
      let reps = 1;
      while (i + (reps + 1) * n <= key.length &&
             key.slice(i + reps * n, i + (reps + 1) * n).join(' ') === key.slice(i, i + n).join(' ')) reps++;
      if (reps >= min) {
        words.splice(i + n, (reps - 1) * n);
        key.splice(i + n, (reps - 1) * n);
        removed++;
      }
    }
  }
  return { text: words.join(' '), removed };
}

export function cleanChunks(chunks) {
  const out = [];
  let removed = 0, prevKey = null;
  for (const c of chunks) {
    const h = dropHallucinations(c.text);
    const r = collapseRepeats(h.text);
    removed += h.removed + r.removed;
    const k = norm(r.text);
    if (!k) continue;
    if (k === prevKey) { removed++; continue; }
    prevKey = k;
    out.push({ ...c, text: r.text });
  }
  return { chunks: out, removed };
}
