# Lokale server (experimenteel)

Draait het Dutch Whisper-fine-tune model (`yuriyvnv/whisper-large-v3-high-mixed-nl`,
geconverteerd naar MLX) als server op dit netwerk, zodat de browser-app het kan
gebruiken in plaats van de in-browser transformers.js modellen. Bedoeld om nu op een
gewone Mac te testen, en straks ongewijzigd op een Mac mini te draaien.

## Setup

1. `cd backend`
2. `python3 -m venv .venv && source .venv/bin/activate`
3. `pip install mlx-whisper numpy`
4. Zorg dat `backend/models/yuriyvnv-nl/` bestaat met `config.json` en
   `weights.safetensors` (zie "Model produceren" hieronder als die map leeg is).
5. `python3 server.py` — luistert op `http://0.0.0.0:8000`. Het eerste request duurt
   iets langer doordat het model wordt opgewarmd; dat gebeurt al bij het starten.
6. In de app: kies bij "2 · Uitschrijven" de optie "Lokale server" en vul de URL in
   (standaard `http://localhost:8000`, of het LAN-adres van de Mac mini zodra die er is).

## Model produceren

Het model in `models/yuriyvnv-nl/` is geconverteerd van de HuggingFace checkpoint
`yuriyvnv/whisper-large-v3-high-mixed-nl` (Apache-2.0) naar MLX-formaat met het
aangepaste conversiescript in `../backend-test/convert.py` (dat script is gepatcht om
sharded safetensors-checkpoints te ondersteunen, wat de originele mlx-examples
`convert.py` niet kan):

```sh
cd ../backend-test
source .venv/bin/activate
python3 convert.py --torch-name-or-path yuriyvnv/whisper-large-v3-high-mixed-nl \
  --mlx-path ../backend/models/yuriyvnv-nl --dtype float16
mv ../backend/models/yuriyvnv-nl/model.safetensors ../backend/models/yuriyvnv-nl/weights.safetensors
```

## Waarom dit model en deze instelling

Vergeleken met stock `whisper-large-v3` en een aantal andere Nederlandse fine-tunes op
een echte interviewopname: dit model met `condition_on_previous_text=False` was zowel
sneller als nauwkeuriger (vooral op namen/plaatsnamen), en zonder de
herhalingslus-bug die Whisper soms heeft. Zie `../backend-test/` voor de test-opzet.
