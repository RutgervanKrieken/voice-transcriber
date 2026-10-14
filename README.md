# Voice Transcriber (prototype)

Record or upload audio, transcribe Dutch speech locally in the browser with Whisper
(transformers.js), edit, and download the text and audio. Audio never leaves the device.

## Run locally

```sh
cd voice-transcriber
python3 serve.py 8080   # like http.server, but without caching
```

Open http://localhost:8080 in Edge or Chrome. Microphone access requires `localhost` or https.

- **small** model (~250 MB): works on any computer (CPU).
- **large** model (~1 GB): better accuracy, needs WebGPU (recent Edge/Chrome on a decent GPU).
- Models download on first use and are cached by the browser.

## Files

- `index.html`: UI (Dutch)
- `app.js`: recording, transcription loop, saved jobs, Copilot steps
- `audio.js`: decoding to 16 kHz mono (WAV/MP3 in 16 MB pieces), cutting at quiet moments
- `pcm-worklet.js`: captures 16 kHz samples from the mic while recording
- `worker.js`: Whisper (transformers.js) in a Web Worker, Dutch
- `store.js`: IndexedDB (jobs, audio, recording parts)
- `clean.js`: removes repetition loops and Whisper's stock "subtitle" phrases
- `copilot.js`: Copilot prompts; long transcripts split into ≤12,000-character messages

## How long recordings are handled

- Audio is cut into ~5 minute segments; progress is saved after each one, so a crash or
  closed tab can resume from the last segment ("Verdergaan").
- Each segment is cut into ≤30 s windows at quiet moments, one Whisper pass each.
  (transformers.js' own long-form stitching lost or repeated sentences in testing.)
- Recordings are saved to IndexedDB every second while recording and recovered after a crash.
- Uploads up to 500 MB are stored for resuming; larger files must be re-selected.

## Summaries

"Summarize with Copilot" copies a Dutch prompt (meeting notes / short / interview) plus the
transcript to the clipboard and opens Copilot Chat; the user pastes and sends. No API needed.
Works with the free Copilot Chat (work account). One-click summaries via the Copilot Chat API
are not possible: that API needs a paid Microsoft 365 Copilot license, which we don't have.

## Next: SharePoint version

Planned as an SPFx web part on the team SharePoint site:
- users are already signed in, so no separate login and no Entra app registration
- "Save to SharePoint" uploads audio + transcript to a document library with the user's own permissions
- model files hosted in a SharePoint library, so nothing is downloaded from outside the tenant
