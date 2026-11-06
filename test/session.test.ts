import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProposals } from '../src/llm.ts';
import {
  acceptProposal,
  addProposals,
  addSegment,
  ApiError,
  closeSession,
  createNode,
  createSession,
  deleteNode,
  normalizeText,
  patchNode,
  publicState,
  rejectProposal,
} from '../src/session.ts';
import { cleanTranscript } from '../src/stt.ts';

function fixture() {
  const s = createSession('Point management');
  const t0 = new Date(Date.now() - 60_000);
  addSegment(s, 'On parle du rattachement DevOps.', t0, new Date(t0.getTime() + 25_000));
  addSegment(s, 'Je propose de le garder hors du rattachement formel.', new Date(t0.getTime() + 25_000), new Date());
  return s;
}

const rejects = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: unknown) => e instanceof ApiError && e.status === status);

test('une séance démarre avec la racine qui porte le titre', () => {
  const s = createSession('  Point   management ');
  assert.equal(s.nodes.length, 1);
  assert.deepEqual([s.nodes[0].id, s.nodes[0].type, s.nodes[0].text], ['n_0', 'racine', 'Point management']);
  assert.notEqual(s.keys.host, s.keys.guest);
  assert.ok(!('keys' in publicState(s)));
});

test('le texte est ramené à 140 caractères au plus', () => {
  const long = 'mot '.repeat(60);
  const t = normalizeText(long);
  assert.ok(t.length <= 140, `${t.length}`);
  assert.ok(t.endsWith('…'));
});

test('un lot du LLM : index, parents invalides, doublons, sources inconnues', () => {
  const s = fixture();
  const added = addProposals(s, [
    { type: 'question', text: 'Faut-il rattacher le pôle DevOps ?', parent: 'n_0', sources: ['t_1'] },
    { type: 'proposition', text: 'Garder le DevOps hors du rattachement formel', parent: '#0', sources: ['t_2', 't_99'] },
    { type: 'contre', text: 'Le pôle perd son interlocuteur', parent: 1, sources: [] },
    { type: 'pour', text: 'Mauvais parent', parent: 'n_0', sources: [] },
    { type: 'inconnu', text: 'x', parent: 'n_0', sources: [] },
    { type: 'question', text: 'faut il rattacher le pôle devops', parent: 'n_0', sources: [] },
  ]);
  assert.equal(added.length, 4);
  const [q, p, c, bad] = added;
  assert.equal(q.parent, 'n_0');
  assert.equal(p.parent, q.id);
  assert.equal(c.parent, p.id);
  assert.equal(bad.parent, null, 'un « pour » ne va pas sous la racine');
  assert.deepEqual(p.sources, ['t_2']);
  assert.ok(p.latencyS !== null && p.latencyS >= 0);
  assert.equal(s.stats.proposalsCreated, 4);
});

test('accepter un enfant accepte toute la chaîne en file', () => {
  const s = fixture();
  const [q, p, c] = addProposals(s, [
    { type: 'question', text: 'Q ?', parent: 'n_0', sources: [] },
    { type: 'proposition', text: 'P', parent: '#0', sources: [] },
    { type: 'contre', text: 'C', parent: '#1', sources: [] },
  ]);
  const node = acceptProposal(s, c.id);
  assert.equal(s.proposals.length, 0);
  assert.equal(s.nodes.length, 4);
  const byText = Object.fromEntries(s.nodes.map((n) => [n.text, n]));
  assert.equal(byText['Q ?'].parent, 'n_0');
  assert.equal(byText['P'].parent, byText['Q ?'].id);
  assert.equal(node.parent, byText['P'].id);
  assert.equal(s.stats.accepted, 3);
  void q;
  void p;
});

test('accepter le parent rattache les enfants en file au nouveau nœud', () => {
  const s = fixture();
  const [q, p] = addProposals(s, [
    { type: 'question', text: 'Q ?', parent: 'n_0', sources: [] },
    { type: 'proposition', text: 'P', parent: '#0', sources: [] },
  ]);
  const nq = acceptProposal(s, q.id);
  assert.equal(s.proposals.find((x) => x.id === p.id)?.parent, nq.id);
});

test('une chaîne invalide ne modifie rien', () => {
  const s = fixture();
  const [q] = addProposals(s, [{ type: 'question', text: 'Q ?', parent: 'n_0', sources: [] }]);
  const nq = acceptProposal(s, q.id);
  const [pour] = addProposals(s, [{ type: 'pour', text: 'Argument', parent: 'n_0', sources: [] }]);
  rejects(() => acceptProposal(s, pour.id), 400);
  rejects(() => acceptProposal(s, pour.id, nq.id), 409);
  assert.equal(s.nodes.length, 2);
  assert.equal(s.proposals.length, 1);
});

test('rejeter un parent remonte ses enfants, ou les laisse à rattacher', () => {
  const s = fixture();
  const [q, p, c] = addProposals(s, [
    { type: 'question', text: 'Q ?', parent: 'n_0', sources: [] },
    { type: 'proposition', text: 'P', parent: '#0', sources: [] },
    { type: 'contre', text: 'C', parent: '#1', sources: [] },
  ]);
  rejectProposal(s, p.id);
  assert.equal(s.proposals.find((x) => x.id === c.id)?.parent, null, 'un « contre » ne va pas sous une question');
  rejectProposal(s, q.id);
  assert.equal(s.rejected.length, 2);
  // Un doublon d'une proposition rejetée n'est pas reproposé.
  assert.equal(addProposals(s, [{ type: 'question', text: 'Q ?', parent: 'n_0', sources: [] }]).length, 0);
});

test('modifier un nœud : type, parent, cycles, retouches', () => {
  const s = fixture();
  const q = createNode(s, { type: 'question', text: 'Q ?', parent: 'n_0' });
  const p = createNode(s, { type: 'proposition', text: 'P', parent: q.id });
  createNode(s, { type: 'pour', text: 'Pour', parent: p.id });
  rejects(() => createNode(s, { type: 'pour', text: 'x', parent: q.id }), 409);
  rejects(() => patchNode(s, q.id, { parent: p.id }), 409);
  rejects(() => patchNode(s, p.id, { type: 'question' }), 409);
  rejects(() => patchNode(s, 'n_0', { type: 'question' }), 400);

  const [prop] = addProposals(s, [{ type: 'contre', text: 'Contre', parent: p.id, sources: [] }]);
  const nc = acceptProposal(s, prop.id);
  patchNode(s, nc.id, { text: 'Contre reformulé' });
  patchNode(s, nc.id, { text: 'Contre reformulé encore' });
  assert.equal(s.stats.acceptedEdited, 1);
  assert.equal(publicState(s).stats.acceptedUnchanged, 0);

  patchNode(s, 'n_0', { text: 'Nouveau titre' });
  assert.equal(s.title, 'Nouveau titre');
});

test('supprimer un nœud supprime ses descendants et rattrape la file', () => {
  const s = fixture();
  const q = createNode(s, { type: 'question', text: 'Q ?', parent: 'n_0' });
  const p = createNode(s, { type: 'proposition', text: 'P', parent: q.id });
  createNode(s, { type: 'pour', text: 'Pour', parent: p.id });
  const [onP, onQ] = addProposals(s, [
    { type: 'contre', text: 'Contre', parent: p.id, sources: [] },
    { type: 'proposition', text: 'Autre', parent: q.id, sources: [] },
  ]);
  deleteNode(s, p.id);
  assert.deepEqual(
    s.nodes.map((n) => n.id),
    ['n_0', q.id],
  );
  assert.equal(s.proposals.find((x) => x.id === onP.id)?.parent, null);
  assert.equal(s.proposals.find((x) => x.id === onQ.id)?.parent, q.id);
  rejects(() => deleteNode(s, 'n_0'), 400);
});

test('une séance close refuse les actions', () => {
  const s = fixture();
  closeSession(s);
  rejects(() => createNode(s, { type: 'question', text: 'Q ?', parent: 'n_0' }), 409);
});

test('lecture de la réponse du LLM', () => {
  assert.equal(parseProposals('{"proposals":[]}').length, 0);
  assert.equal(parseProposals('```json\n{"proposals":[{"type":"question","text":"Q","parent":"n_0","sources":[]}]}\n```').length, 1);
  assert.equal(parseProposals('Voici : [{"type":"pour","text":"x"}] fin').length, 1);
  assert.throws(() => parseProposals('rien'));
});

test('nettoyage des hallucinations de Whisper', () => {
  assert.equal(cleanTranscript("Sous-titres réalisés par la communauté d'Amara.org", ''), '');
  assert.equal(cleanTranscript('Merci d’avoir regardé cette vidéo !', ''), '');
  assert.equal(cleanTranscript('On avance. On avance. On avance. Et après ?', ''), 'On avance. Et après ?');
  assert.equal(cleanTranscript('la suite du point', 'la suite du point'), '');
  assert.equal(
    cleanTranscript("Bon, on décide ça. Sous-titres réalisés par la communauté d'Amara.org", ''),
    'Bon, on décide ça.',
  );
});
