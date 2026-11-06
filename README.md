# carte-reunion

Pendant une réunion Visio, une carte partagée des questions, propositions, arguments et décisions, mise à jour au fil de la conversation. Un LLM propose les nœuds à partir de la transcription ; les participants les acceptent, les corrigent, les rattachent ou les rejettent. Rien n'entre dans la carte sans un humain.

Prototype, d'après la spécification v1 du 6 novembre 2026.

## Comment ça marche

```
navigateur de l'animateur ──tranche audio 25 s──▶ service ──▶ LiteLLM → whisper-large-v3
  (onglet Visio + micro)                           │  ◀── texte
                                                    ├──▶ LiteLLM → gpt-oss-120b (delta + carte, toutes les 30 s)
navigateurs des participants ◀──SSE : carte + file──┤  ◀── propositions JSON
                             ──accepter, rejeter…──▶┘
```

- Un seul service Node 24 en TypeScript, exécuté sans compilation, qui sert l'interface et l'API.
- Interface sans framework : HTML, CSS, JS, carte en SVG mise en page par dagre.
- État en mémoire, sauvegardé en JSON dans `DATA_DIR` toutes les 30 s et à l'arrêt, supprimé 24 h après la dernière activité. L'audio n'est jamais écrit sur disque.

## Démarrer en local

```bash
npm install
cp .env.example .env   # renseigner LITELLM_BASE_URL et LITELLM_API_KEY
npm run dev            # http://localhost:3000
```

Créer une séance depuis la page d'accueil, puis :

- **Animateur** (Chrome ou Edge) : ouvrir Visio dans un autre onglet, cliquer sur Capturer, choisir l'onglet Visio en cochant le partage du son, autoriser le micro. Avec un casque.
- **Participants** : bouton « Lien participants », à coller dans le chat Visio.

### Sans réunion : rejouer une transcription

```bash
npm run replay -- samples/reunion-exemple.txt --every 6
```

Crée une séance, affiche les deux liens et envoie un paragraphe toutes les 6 s comme s'il sortait de la transcription. Le serveur doit tourner avec `DEV_TEXT_INPUT=true`.

### Choisir le modèle et régler la consigne

```bash
node --env-file=.env scripts/compare-models.ts samples/reunion-exemple.txt scaleway/gpt-oss-120b scaleway/mistral-medium-3.5-128b
```

Rejoue la transcription hors serveur, accepte tout ce qui est rattachable et affiche l'arbre obtenu, la durée des appels et le coût. Mesures du 6 novembre 2026 sur `samples/reunion-exemple.txt` (8 min de réunion fictive, 10 cycles) :

| Modèle | Résultat | Durée par appel | Coût |
|---|---|---|---|
| gpt-oss-120b | le plus fidèle : décisions, actions, arguments bien rattachés | 5 à 8 s | 0,008 € |
| mistral-medium-3.5-128b | bon, quelques types faux | 2,3 s | 0,031 € |
| mistral-small-3.2-24b | rate les décisions, invente des arguments | 1,3 s | 0,003 € |
| qwen3-235b-a22b-instruct | rate les actions, 11 propositions non rattachables | 1,5 s | 0,014 € |
| deepseek-v4-flash | 4 réponses vides sur 10 | 4,9 s | 0,010 € |

### Tests

```bash
npm run typecheck && npm test
```

## Configuration

Voir [.env.example](.env.example). Les valeurs par défaut sont dans [src/config.ts](src/config.ts).

| Variable | Défaut | Rôle |
|---|---|---|
| `LITELLM_BASE_URL` | | URL LiteLLM avec `/v1` |
| `LITELLM_API_KEY` | | Clé de service LiteLLM |
| `STT_MODEL` | `scaleway/whisper-large-v3` | Transcription |
| `LLM_MODEL` | `scaleway/gpt-oss-120b` | Propositions |
| `CHUNK_SECONDS` | 25 | Durée d'une tranche audio |
| `MAP_INTERVAL_SECONDS` | 30 | Intervalle entre deux cycles LLM |
| `MAP_MIN_NEW_WORDS` | 150 | Déclenche un cycle avant l'intervalle |
| `MAP_INTERVAL_MIN_WORDS` | 20 | En dessous, l'intervalle ne déclenche rien |
| `SESSION_TTL_HOURS` | 24 | Suppression après la dernière activité |
| `DATA_DIR` | `./data` | Sauvegardes JSON |
| `CREATE_TOKEN` | | Si renseigné, exigé pour créer une séance |
| `DEV_TEXT_INPUT` | `false` | Active l'envoi de texte sans audio (rejeu) |

La transcription passe par le modèle `scaleway/whisper-large-v3`, ajouté à LiteLLM le 6 novembre 2026 (credential Scaleway, 0,003 € la minute, mode `audio_transcription`). La clé utilisée doit appartenir à une équipe qui a ce modèle dans sa liste.

## Déployer

```bash
docker build -t ghcr.io/socialgouv/carte-reunion:<sha> .
kubectl -n carte-reunion create secret generic carte-reunion-secrets \
  --from-literal=LITELLM_API_KEY=sk-... --from-literal=CREATE_TOKEN=$(openssl rand -hex 16)
kubectl apply -k k8s/
```

La CI construit et pousse l'image à chaque commit sur `main`. Dans [k8s/](k8s/) : remplacer `DOMAINE-FABRIQUE` et `LITELLM-DNUM`, vérifier l'émetteur de certificats.

- **Un seul replica**, stratégie `Recreate` : l'état est en mémoire.
- **Ne pas déployer pendant une réunion** : le volume `emptyDir` survit au redémarrage du conteneur, pas au remplacement du pod.
- **SSE** : les annotations `proxy-read-timeout` et `proxy-buffering` de l'Ingress sont indispensables.

## Choix faits par rapport à la spec v1

| Sujet | Choix |
|---|---|
| Proposition rattachée à une autre proposition | Accepter un enfant accepte toute la chaîne de parents en file. Rejeter un parent remonte ses enfants d'un cran ; s'ils ne peuvent pas s'y rattacher, ils passent « à rattacher ». Le LLM peut aussi rattacher à une proposition en attente d'un lot précédent. |
| Règles de parenté | Strictes pour tous, comme dans la spec. Une proposition du LLM au parent invalide reste dans la file, « à rattacher » : un humain choisit. La racine n'accepte que des questions ; la consigne demande au LLM de proposer la question sous-jacente quand elle manque. |
| Extraits au survol | L'état diffusé contient les segments cités par un nœud ou une proposition, plus les trois derniers segments (« Transcription récente »). |
| Indicateurs de validation | Identifiant anonyme aléatoire par navigateur (pas de nom) pour compter les participants qui ont agi ; compteurs d'acceptations avec ou sans retouche, délai propos → proposition, coût. Panneau « Indicateurs ». |
| Propositions rejetées | Les 30 dernières sont données au LLM pour qu'il ne les repropose pas. |
| Création de séance | `CREATE_TOKEN` optionnel, à renseigner en production. |
| Intervalle LLM | 30 s par défaut au lieu de 60 s, pour tenir les 90 s au pire. |
| Silences | Tranche non envoyée si moins de 0,6 s de parole ; hallucinations connues de Whisper retirées (« Sous-titres réalisés par… »). |
| Cadence des tranches | Pilotée par un AudioWorklet et non par `setTimeout`, que Chrome ralentit à une minute quand l'onglet de la carte est en arrière-plan. |
| File des propositions | Les plus anciennes en haut : une nouvelle fournée n'en déplace pas les cartes sous la souris. |

## Limites connues

- La capture audio n'a pas encore été testée de bout en bout dans une vraie réunion Visio.
- Pas d'identification des intervenants (v2 : bot LiveKit). Les champs `speaker` et `links` sont déjà prévus.
- La carte devient haute au-delà d'une cinquantaine de nœuds : zoom et déplacement à la souris, bouton Ajuster.

## Organisation du code

| Fichier | Rôle |
|---|---|
| [src/session.ts](src/session.ts) | Règles de la carte : accepter, rejeter, créer, modifier, supprimer, valider un lot du LLM |
| [src/llm.ts](src/llm.ts) | Consigne, construction du message, lecture de la réponse |
| [src/cycle.ts](src/cycle.ts) | Déclenchement des cycles LLM, un seul à la fois par séance |
| [src/stt.ts](src/stt.ts) | File de transcription par séance, nettoyage du texte |
| [src/store.ts](src/store.ts) | Séances en mémoire, sauvegarde, expiration, diffusion |
| [src/server.ts](src/server.ts) | Routes HTTP et SSE |
| [public/app.js](public/app.js) | Interface : carte, file, panneau du nœud |
| [public/capture.js](public/capture.js), [public/audio-clock.js](public/audio-clock.js) | Capture côté animateur |
