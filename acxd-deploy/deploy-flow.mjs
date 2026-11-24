#!/usr/bin/env node
/**
 * Deploy an exported Agentic CX Designer (ACXD) flow JSON into a workspace via the ACXD SDK.
 *
 * Idempotent: creates the flow if it does not exist, otherwise updates it in place
 * (matched by flowId). Reading remains non-destructive; the only writes are the
 * CreateFlow / UpdateFlow the user explicitly asked for.
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node deploy-flow.mjs ./flows/AcmeStart.json
 *
 * Flags:
 *   --dry-run   Transform + validate the payload and print it, without calling the API.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-flows.html
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Config from environment (never hardcode the API key)
// ---------------------------------------------------------------------------
const API_KEY = process.env.ACXD_API_KEY;
const WORKSPACE_ID = process.env.ACXD_WORKSPACE_ID;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const filePath = args.find((a) => !a.startsWith('--'));

function fail(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

if (!filePath) {
  fail('Provide the path to an exported flow JSON file. See usage in the file header.');
}
if (!DRY_RUN && !API_KEY) {
  fail('ACXD_API_KEY is not set. Export it or run with --dry-run.');
}
if (!DRY_RUN && !WORKSPACE_ID) {
  fail('ACXD_WORKSPACE_ID is not set. Export it or run with --dry-run.');
}

// ---------------------------------------------------------------------------
// Transform: exported flow JSON -> CreateFlow / UpdateFlow payload
//
// The workspace export and the SDK request shape differ in a few field names,
// and the export carries UI-only + server-generated fields the API rejects.
// Per the CreateFlow reference, the accepted params are:
//   flowId, description, nodes, aiDescription, untrained,
//   mainLanguageCode, languageCode, languageCodes,
//   slotTypes, contextVariables, mcp, metadata
// ---------------------------------------------------------------------------

/** Fields that are read-only / server-generated and must not be sent. */
const READ_ONLY_FIELDS = ['saveId', 'createdAt', 'updatedAt', 'updatedBy'];

/** Top-level export fields that are not CreateFlow params (dropped). */
const NON_API_FIELDS = ['type', 'mirroring'];

function transformExportToRequest(exported) {
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
    nodes: exported.nodes,
  };

  // Optional pass-through fields (only when present).
  if (exported.description != null) req.description = exported.description;
  if (exported.aiDescription != null) req.aiDescription = exported.aiDescription;
  if (exported.untrained != null) req.untrained = exported.untrained;
  if (exported.languageCodes != null) req.languageCodes = exported.languageCodes;
  if (exported.languageCode != null) req.languageCode = exported.languageCode;
  if (exported.contextVariables != null) req.contextVariables = exported.contextVariables;
  if (exported.mcp != null) req.mcp = exported.mcp;
  if (exported.metadata != null) req.metadata = exported.metadata;

  // Field name mapping: export uses masterLanguageCode; API uses mainLanguageCode.
  if (exported.mainLanguageCode != null) {
    req.mainLanguageCode = exported.mainLanguageCode;
  } else if (exported.masterLanguageCode != null) {
    req.mainLanguageCode = exported.masterLanguageCode;
  }

  // Field name mapping: export uses "slots"; API uses "slotTypes" (Attached Slot shape:
  // name, type, sensitive, examples, aiDescription, regex).
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

/** Light validation that mirrors the documented constraints, to catch errors before the API round-trip. */
function validateRequest(req) {
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
  if (nodeIds.length === 0) {
    problems.push('nodes is empty.');
  }
  const startNodes = nodeIds.filter((id) => req.nodes[id]?.type === 'start');
  if (startNodes.length !== 1) {
    problems.push(`expected exactly one "start" node, found ${startNodes.length}.`);
  }

  // Referential integrity: every childNode target (when present) must resolve to a node.
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

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------
async function main() {
  const abs = resolve(filePath);
  const raw = await readFile(abs, 'utf8');

  let exported;
  try {
    exported = JSON.parse(raw);
  } catch (e) {
    fail(`Could not parse JSON in ${abs}: ${e.message}`);
  }

  // Defensive: strip read-only fields if the export included them.
  for (const f of READ_ONLY_FIELDS) delete exported[f];
  for (const f of NON_API_FIELDS) delete exported[f];

  const request = transformExportToRequest(exported);

  const problems = validateRequest(request);
  if (problems.length) {
    console.error('\x1b[31mValidation failed:\x1b[0m');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `Flow "${request.flowId}" validated: ${Object.keys(request.nodes).length} nodes, ` +
      `${request.slotTypes?.length ?? 0} slot(s).`,
  );

  if (DRY_RUN) {
    console.log('\n--- Dry run: request payload (not sent) ---');
    console.log(JSON.stringify(request, null, 2));
    return;
  }

  // Lazy import so --dry-run works without the SDK installed.
  let AgenticCXDesignerClient, CreateFlowCommand, UpdateFlowCommand, GetFlowCommand;
  try {
    ({
      AgenticCXDesignerClient,
      CreateFlowCommand,
      UpdateFlowCommand,
      GetFlowCommand,
    } = await import('amazon-connect-acxd-sdk'));
  } catch (e) {
    fail(
      'Could not load "amazon-connect-acxd-sdk". Run "npm install" in acxd-deploy first, ' +
        `or use --dry-run to preview the payload. (${e.message})`,
    );
  }

  const client = new AgenticCXDesignerClient({
    apiKey: API_KEY,
    workspaceId: WORKSPACE_ID,
  });

  // Decide create vs update by probing for the existing flow.
  let exists = false;
  try {
    await client.send(new GetFlowCommand({ flowIdentifier: request.flowId }));
    exists = true;
  } catch (e) {
    // ResourceNotFoundException -> create path. Anything else is a real error.
    if (e?.name !== 'ResourceNotFoundException' && e?.$metadata?.httpStatusCode !== 404) {
      fail(`GetFlow failed: ${e?.name ?? ''} ${e?.message ?? e}`);
    }
  }

  try {
    if (exists) {
      console.log(`Flow "${request.flowId}": updating (already exists)`);
      const { flowId, ...rest } = request;
      const res = await client.send(
        new UpdateFlowCommand({ flowIdentifier: flowId, ...rest }),
      );
      console.log(`Updated. saveId=${res?.saveId ?? 'n/a'} updatedAt=${res?.updatedAt ?? 'n/a'}`);
    } else {
      console.log(`Flow "${request.flowId}": creating (new)`);
      const res = await client.send(new CreateFlowCommand(request));
      console.log(`Created. saveId=${res?.saveId ?? 'n/a'} createdAt=${res?.createdAt ?? 'n/a'}`);
    }
  } catch (e) {
    // If a concurrent create raced us, fall back to update once.
    if ((e?.name === 'ConflictException' || e?.$metadata?.httpStatusCode === 409) && !exists) {
      console.log(`Flow "${request.flowId}": updating (created concurrently, retried as update)`);
      const { flowId, ...rest } = request;
      const res = await client.send(
        new UpdateFlowCommand({ flowIdentifier: flowId, ...rest }),
      );
      console.log(`Updated. saveId=${res?.saveId ?? 'n/a'} updatedAt=${res?.updatedAt ?? 'n/a'}`);
    } else {
      fail(`Deploy failed: ${e?.name ?? ''} ${e?.message ?? e}`);
    }
  }

  console.log('\x1b[32mDone.\x1b[0m Changes take effect after you build + deploy the application.');
}

main().catch((e) => fail(e?.stack ?? String(e)));
