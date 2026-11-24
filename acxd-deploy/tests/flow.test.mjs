import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformFlow, validateFlow } from '../lib/flow.mjs';

test('transformFlow drops read-only and non-API fields', () => {
  const req = transformFlow({
    flowId: 'AcmeStart',
    nodes: { n1: { type: 'start', childNodes: [] } },
    saveId: 'x',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    updatedBy: 'someone',
    type: 'flow',
    mirroring: {},
  });
  assert.equal(req.saveId, undefined);
  assert.equal(req.createdAt, undefined);
  assert.equal(req.type, undefined);
  assert.equal(req.mirroring, undefined);
  assert.equal(req.flowId, 'AcmeStart');
});

test('transformFlow maps masterLanguageCode -> mainLanguageCode', () => {
  const req = transformFlow({
    flowId: 'AcmeStart',
    nodes: { n1: { type: 'start' } },
    masterLanguageCode: 'en-US',
  });
  assert.equal(req.mainLanguageCode, 'en-US');
});

test('transformFlow maps slots -> slotTypes', () => {
  const req = transformFlow({
    flowId: 'AcmeStart',
    nodes: { n1: { type: 'start' } },
    slots: [{ name: 'memberId', type: 'custom', sensitive: true }],
  });
  assert.equal(req.slotTypes.length, 1);
  assert.equal(req.slotTypes[0].name, 'memberId');
  assert.equal(req.slotTypes[0].sensitive, true);
});

test('transformFlow normalizes redirect intentId -> flowId without mutating input', () => {
  const input = {
    flowId: 'AcmeStart',
    nodes: { n1: { type: 'start', metadata: { redirect: { id: 'X', intentId: 'AcmeMain' } } } },
  };
  const req = transformFlow(input);
  assert.equal(req.nodes.n1.metadata.redirect.flowId, 'AcmeMain');
  // original input must be untouched
  assert.equal(input.nodes.n1.metadata.redirect.flowId, undefined);
});

test('transformFlow throws on missing flowId', () => {
  assert.throws(() => transformFlow({ nodes: {} }), /missing required "flowId"/);
});

test('transformFlow throws on missing nodes', () => {
  assert.throws(() => transformFlow({ flowId: 'AcmeStart' }), /missing required "nodes"/);
});

test('validateFlow accepts a well-formed flow', () => {
  const problems = validateFlow({
    flowId: 'AcmeStart',
    nodes: { n1: { type: 'start', childNodes: [{ nodeId: 'n2' }] }, n2: { type: 'message' } },
  });
  assert.deepEqual(problems, []);
});

test('validateFlow flags bad flowId, multiple start nodes, and dangling child', () => {
  const problems = validateFlow({
    flowId: 'bad id!',
    nodes: {
      n1: { type: 'start' },
      n2: { type: 'start', childNodes: [{ nodeId: 'ghost' }] },
    },
  });
  assert.ok(problems.some((p) => p.includes('flowId')));
  assert.ok(problems.some((p) => p.includes('start')));
  assert.ok(problems.some((p) => p.includes('ghost')));
});
