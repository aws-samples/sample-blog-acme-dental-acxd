/**
 * Flow transform, validation, and deploy logic shared by deploy-flow.mjs and deploy-all.mjs.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-flows.html
 */

/** Read-only / server-generated fields that must not be sent. */
const READ_ONLY_FIELDS = ['saveId', 'createdAt', 'updatedAt', 'updatedBy'];

/** Top-level export fields that are not CreateFlow params (dropped). */
const NON_API_FIELDS = ['type', 'mirroring'];

/**
 * Transform an exported flow object into a CreateFlow / UpdateFlow request.
 * Mutates nothing; returns a fresh request object.
 */
/**
 * Normalize redirect nodes to the shape CreateFlow expects.
 *
 * The export represents an intent-redirect as `metadata.redirect: { id, intentId, type }`,
 * but the API requires `metadata.redirect.flowId` (an intent is a flow). Map intentId/id to
 * flowId when absent, preserving any other redirect fields. Mutates the passed-in nodes
 * object (callers pass a clone).
 */
function normalizeRedirectNodes(nodes) {
  if (!nodes || typeof nodes !== 'object') return nodes;
  for (const node of Object.values(nodes)) {
    const redirect = node?.metadata?.redirect;
    if (redirect && typeof redirect === 'object' && redirect.flowId == null) {
      const target = redirect.intentId ?? redirect.id;
      if (target != null) redirect.flowId = target;
    }
  }
  return nodes;
}

export function transformFlow(exportedInput) {
  const exported = { ...exportedInput };
  for (const f of READ_ONLY_FIELDS) delete exported[f];
  for (const f of NON_API_FIELDS) delete exported[f];

  if (!exported || typeof exported !== 'object') {
    throw new Error('Flow file did not parse to an object.');
  }
  if (!exported.flowId) {
    throw new Error('Flow file is missing required "flowId".');
  }
  if (!exported.nodes || typeof exported.nodes !== 'object') {
    throw new Error('Flow file is missing required "nodes" object.');
  }

  const req = {
    flowId: exported.flowId,
    // Deep-clone nodes so redirect normalization below never mutates the caller's input.
    nodes: normalizeRedirectNodes(structuredClone(exported.nodes)),
  };

  if (exported.description != null) req.description = exported.description;
  if (exported.aiDescription != null) req.aiDescription = exported.aiDescription;
  if (exported.untrained != null) req.untrained = exported.untrained;
  if (exported.languageCodes != null) req.languageCodes = exported.languageCodes;
  if (exported.languageCode != null) req.languageCode = exported.languageCode;
  if (exported.contextVariables != null) req.contextVariables = exported.contextVariables;
  if (exported.mcp != null) req.mcp = exported.mcp;
  if (exported.metadata != null) req.metadata = exported.metadata;

  // export masterLanguageCode -> API mainLanguageCode
  if (exported.mainLanguageCode != null) {
    req.mainLanguageCode = exported.mainLanguageCode;
  } else if (exported.masterLanguageCode != null) {
    req.mainLanguageCode = exported.masterLanguageCode;
  }

  // export slots -> API slotTypes (Attached Slot shape)
  const slotSource = exported.slotTypes ?? exported.slots;
  if (Array.isArray(slotSource)) {
    req.slotTypes = slotSource.map((s) => {
      const slot = { name: s.name, type: s.type };
      if (s.sensitive != null) slot.sensitive = s.sensitive;
      if (s.examples != null) slot.examples = s.examples;
      if (s.aiDescription != null) slot.aiDescription = s.aiDescription;
      if (s.regex != null) slot.regex = s.regex;
      return slot;
    });
  }

  return req;
}

/** Validate a flow request against documented constraints. Returns an array of problems. */
export function validateFlow(req) {
  const problems = [];

  if (!/^[A-Za-z0-9]{3,64}$/.test(req.flowId)) {
    problems.push(`flowId "${req.flowId}" must be alphanumeric, 3-64 chars.`);
  }
  if (req.description != null && req.description.length > 200) {
    problems.push('description exceeds 200 characters.');
  }
  if (req.aiDescription != null && req.aiDescription.length > 1000) {
    problems.push('aiDescription exceeds 1000 characters.');
  }

  const nodeIds = Object.keys(req.nodes);
  if (nodeIds.length === 0) problems.push('nodes is empty.');

  const startNodes = nodeIds.filter((id) => req.nodes[id]?.type === 'start');
  if (startNodes.length !== 1) {
    problems.push(`expected exactly one "start" node, found ${startNodes.length}.`);
  }

  const idSet = new Set(nodeIds);
  for (const id of nodeIds) {
    const children = req.nodes[id]?.childNodes ?? [];
    for (const child of children) {
      if (child.nodeId != null && !idSet.has(child.nodeId)) {
        problems.push(`node "${id}" references unknown child "${child.nodeId}".`);
      }
    }
  }

  for (const slot of req.slotTypes ?? []) {
    if (!/^[A-Za-z]{3,30}$/.test(slot.name)) {
      problems.push(`slot name "${slot.name}" must be alphabetic, 3-30 chars.`);
    }
  }

  return problems;
}

/**
 * Deploy a flow request via the SDK client (create-or-update, idempotent).
 * `commands` is the imported SDK command set. Returns a short status string.
 */
export async function deployFlow(client, commands, req, log = console.log) {
  const { CreateFlowCommand, UpdateFlowCommand, GetFlowCommand } = commands;

  let exists = false;
  try {
    await client.send(new GetFlowCommand({ flowIdentifier: req.flowId }));
    exists = true;
  } catch (e) {
    if (e?.name !== 'ResourceNotFoundException' && e?.$metadata?.httpStatusCode !== 404) {
      throw new Error(`GetFlow failed: ${e?.name ?? ''} ${e?.message ?? e}`);
    }
  }

  try {
    if (exists) {
      log(`  flow "${req.flowId}": updating (already exists)`);
      const { flowId, ...rest } = req;
      const res = await client.send(new UpdateFlowCommand({ flowIdentifier: flowId, ...rest }));
      return `updated (saveId=${res?.saveId ?? 'n/a'})`;
    }
    log(`  flow "${req.flowId}": creating (new)`);
    const res = await client.send(new CreateFlowCommand(req));
    return `created (saveId=${res?.saveId ?? 'n/a'})`;
  } catch (e) {
    if ((e?.name === 'ConflictException' || e?.$metadata?.httpStatusCode === 409) && !exists) {
      log(`  flow "${req.flowId}": updating (created concurrently, retried as update)`);
      const { flowId, ...rest } = req;
      const res = await client.send(new UpdateFlowCommand({ flowIdentifier: flowId, ...rest }));
      return `updated after conflict (saveId=${res?.saveId ?? 'n/a'})`;
    }
    throw new Error(`Deploy flow "${req.flowId}" failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }
}
