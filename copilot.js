// Copilot Chat has no API without a paid license, so we prepare text to paste.
// Long transcripts are split into parts sent in one conversation; Copilot gets
// the assignment with the last part, so it summarises the whole transcript.
export const MAX_CHARS = 12000; // stay well under Copilot Chat's message limit

export const PROMPTS = {
  meeting: `Maak beknopte notulen in het Nederlands van het transcript van een vergadering.
Gebruik deze kopjes:
1. Samenvatting (3-5 zinnen)
2. Belangrijkste punten
3. Besluiten
4. Actiepunten (wie, wat, wanneer; vermeld "onbekend" als dat niet genoemd wordt)
5. Open vragen
Verzin niets dat niet in het transcript staat. Het transcript is automatisch gemaakt en kan spraakherkenningsfouten bevatten; corrigeer duidelijke fouten stilzwijgend.`,
  short: `Vat het transcript samen in maximaal 5 zinnen in het Nederlands. Verzin niets dat niet in het transcript staat. Het transcript is automatisch gemaakt en kan spraakherkenningsfouten bevatten.`,
  interview: `Maak in het Nederlands een samenvatting van het gesprek in het transcript.
Gebruik deze kopjes:
1. Onderwerp en context
2. Belangrijkste uitspraken en standpunten
3. Afspraken en vervolgstappen
Verzin niets dat niet in het transcript staat. Het transcript is automatisch gemaakt en kan spraakherkenningsfouten bevatten; corrigeer duidelijke fouten stilzwijgend.`,
};

// Split at paragraph/line breaks, then sentences, then hard, so no piece exceeds max.
function splitText(text, max) {
  const pieces = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! ')) + 1;
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export function buildMessages(instruction, transcript) {
  const single = `${instruction}\n\nTranscript:\n"""\n${transcript}\n"""`;
  if (single.length <= MAX_CHARS) return [single];

  const pieces = splitText(transcript, MAX_CHARS - instruction.length - 500);
  const n = pieces.length;
  return pieces.map((p, i) => {
    const intro = i === 0
      ? `Ik stuur je een transcript in ${n} delen. Antwoord na elk deel alleen met "Deel X van ${n} ontvangen" en wacht op het volgende deel. De opdracht volgt na het laatste deel.\n\n`
      : '';
    const body = `Deel ${i + 1} van ${n}:\n"""\n${p}\n"""`;
    const outro = i === n - 1
      ? `\n\nDit was het laatste deel; je hebt nu het hele transcript. Voer nu deze opdracht uit voor het hele transcript (alle ${n} delen samen):\n\n${instruction}`
      : '';
    return intro + body + outro;
  });
}
