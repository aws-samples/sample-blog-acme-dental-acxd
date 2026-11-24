#!/usr/bin/env node
/**
 * Tear down the ACXD resources deployed by deploy-all.mjs, in safe REVERSE-dependency order:
 *
 *   application deployment(s)
 *     -> application        (DeleteApplication cascades its builds + deployments)
 *       -> flows            (must be detached from the app first, hence after it)
 *         -> data requests
 *           -> knowledge bases
 *             -> context variables
 *               -> slot types
 *                 -> secrets (deleted by default; skip with --keep-secrets)
 *
 * SAFETY:
 *   - This is DESTRUCTIVE. By default it only PREVIEWS what it would delete.
 *   - Nothing is deleted unless you pass --confirm.
 *   - Scoped to the resources defined by this project's local files (the app JSON, the flows/
 *     slot-types/ context-variables/ data-requests/ knowledge-bases/ folders, and
 *     secrets/secrets.json). It never bulk-deletes every resource in the workspace, and it
 *     only deletes a named resource if it currently exists.
 *   - Secrets ARE deleted by default (the ones named in the manifest). Pass --keep-secrets to
 *     leave them in place — useful when they are shared with other apps/people.
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node destroy-all.mjs --confirm [--keep-secrets]
 *
 * Flags:
 *   --app <path>              Application JSON (default: applications/acme-dental.json)
 *   --flows-dir <path>        Flow JSON directory (default: flows)
 *   --slot-types-dir <path>   Slot type JSON directory (default: slot-types)
 *   --context-vars-dir <path> Context variable JSON directory (default: context-variables)
 *   --kb-dir <path>           Knowledge base root (default: knowledge-bases)
 *   --data-requests-dir <path> Data request JSON directory (default: data-requests)
 *   --secrets <path>          Secrets manifest (default: secrets/secrets.json)
 *   --only-referenced-flows   Only delete flows the app references
 *   --keep-flows              Delete the application but leave flows in place
 *   --keep-secrets            Do NOT delete secrets (they are deleted by default)
 *   --confirm                 Actually perform the deletions (without this, it's a preview)
 *
 * SDK references:
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-applications.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-application-deployments.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-flows.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-data-requests.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-knowledge-bases.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-context-variables.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-slot-types.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-secrets.html
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import { transformApplication } from './lib/application.mjs';
import { transformFlow } from './lib/flow.mjs';
import { transformSlotType } from './lib/slot-type.mjs';
import { transformContextVariable } from './lib/context-variable.mjs';
import { transformKnowledgeBase } from './lib/knowledge-base.mjs';
import { transformDataRequest } from './lib/data-request.mjs';

const API_KEY = process.env.ACXD_API_KEY;
const WORKSPACE_ID = process.env.ACXD_WORKSPACE_ID;

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const ONLY_REFERENCED = args.includes('--only-referenced-flows');
const KEEP_FLOWS = args.includes('--keep-flows');
// Secrets are deleted by default (symmetric with deploy). --keep-secrets opts out — useful
// when the secrets are shared with other apps/people. --confirm is still required either way.
const DELETE_SECRETS = !args.includes('--keep-secrets');

function flagValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const APP_PATH = flagValue('--app', 'applications/acme-dental.json');
const FLOWS_DIR = flagValue('--flows-dir', 'flows');
const SLOT_TYPES_DIR = flagValue('--slot-types-dir', 'slot-types');
const CONTEXT_VARS_DIR = flagValue('--context-vars-dir', 'context-variables');
const KB_DIR = flagValue('--kb-dir', 'knowledge-bases');
const DATA_REQUESTS_DIR = flagValue('--data-requests-dir', 'data-requests');
const SECRETS_PATH = flagValue('--secrets', 'secrets/secrets.json');

function fail(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

// Credentials are required even for a preview, since it lists live resources to show exactly
// what would be deleted.
if (!API_KEY) fail('ACXD_API_KEY is not set.');
if (!WORKSPACE_ID) fail('ACXD_WORKSPACE_ID is not set.');

async function readJson(path) {
  const abs = resolve(path);
  const raw = await readFile(abs, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse JSON in ${abs}: ${e.message}`);
  }
}
async function listJson(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}
async function listKbNames(kbRoot) {
  let entries;
  try {
    entries = await readdir(kbRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const kb = transformKnowledgeBase(await readJson(join(kbRoot, e.name, 'knowledge-base.json')));
      names.push(kb.name);
    } catch {
      // skip folders without a valid knowledge-base.json
    }
  }
  return names;
}

// Teardown is resilient: a failed delete is recorded and the run CONTINUES to the next
// resource (so a failure in an early step never silently prevents later steps — e.g. secrets
// — from running). Failures are summarized at the end and set a non-zero exit code.
const deleteFailures = [];

/** Delete helper: 404-tolerant, logs outcome, records (does not abort on) other errors. */
async function tryDelete(label, send) {
  try {
    await send();
    console.log(`  deleted ${label}`);
  } catch (e) {
    if (e?.name === 'ResourceNotFoundException' || e?.$metadata?.httpStatusCode === 404) {
      console.log(`  ${label} already absent, skipped`);
    } else {
      const reason = `${e?.name ?? ''} ${e?.message ?? e}`.trim();
      console.error(`  \x1b[31mFAILED\x1b[0m ${label}: ${reason}`);
      deleteFailures.push({ label, reason });
    }
  }
}

async function main() {
  // ---- Resolve names/ids from local definition files ----
  const appExport = await readJson(APP_PATH);
  const { request: appReq } = transformApplication(appExport);
  const appName = appReq.name;
  const appReferenced = new Set((appReq.flows ?? []).map((f) => f.flowId));

  // Flows
  let flowIdsToDelete = [];
  if (!KEEP_FLOWS) {
    if (ONLY_REFERENCED) {
      flowIdsToDelete = [...appReferenced];
    } else {
      const ids = new Set(appReferenced);
      for (const file of await listJson(FLOWS_DIR)) ids.add(transformFlow(await readJson(file)).flowId);
      flowIdsToDelete = [...ids];
    }
  }

  // Data requests, KBs, context vars, slot types, secrets (names from local files)
  const dataRequestIds = [];
  for (const file of await listJson(DATA_REQUESTS_DIR)) dataRequestIds.push(transformDataRequest(await readJson(file)).dataRequestId);
  const kbNames = await listKbNames(KB_DIR);
  const contextVarNames = [];
  for (const file of await listJson(CONTEXT_VARS_DIR)) contextVarNames.push(transformContextVariable(await readJson(file)).name);
  const slotTypeIds = [];
  for (const file of await listJson(SLOT_TYPES_DIR)) slotTypeIds.push(transformSlotType(await readJson(file)).slotTypeId);
  let secretNames = [];
  if (DELETE_SECRETS) {
    try {
      const m = await readJson(SECRETS_PATH);
      secretNames = (m?.secrets ?? []).map((s) => s.name).filter(Boolean);
    } catch {
      // no manifest -> no secrets
    }
  }

  // ---- Load SDK ----
  let sdk;
  try {
    sdk = await import('amazon-connect-acxd-sdk');
  } catch (e) {
    fail(`Could not load "amazon-connect-acxd-sdk". Run "npm install" first. (${e.message})`);
  }
  const client = new sdk.AgenticCXDesignerClient({ apiKey: API_KEY, workspaceId: WORKSPACE_ID });

  // ---- Resolve the live application + its deployments + KB ids ----
  let applicationId = null;
  try {
    let nextToken;
    do {
      const page = await client.send(new sdk.ListApplicationsCommand({ nextToken }));
      const hit = (page.items ?? []).find((a) => a.name === appName);
      if (hit) {
        applicationId = hit.applicationId;
        break;
      }
      nextToken = page.nextToken ?? undefined;
    } while (nextToken);
  } catch (e) {
    fail(`ListApplications failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }

  let deploymentIds = [];
  if (applicationId) {
    try {
      let nextToken;
      do {
        const page = await client.send(
          new sdk.ListApplicationDeploymentsCommand({ applicationIdentifier: applicationId, nextToken }),
        );
        for (const d of page.items ?? []) deploymentIds.push(d.deploymentId);
        nextToken = page.nextToken ?? undefined;
      } while (nextToken);
    } catch (e) {
      fail(`ListApplicationDeployments failed: ${e?.name ?? ''} ${e?.message ?? e}`);
    }
  }

  // Resolve KB names -> ids (KBs are deleted by id).
  const kbIdByName = new Map();
  if (kbNames.length) {
    try {
      let nextToken;
      do {
        const page = await client.send(new sdk.ListKnowledgeBasesCommand({ nextToken }));
        for (const k of page.items ?? []) if (kbNames.includes(k.name)) kbIdByName.set(k.name, k.knowledgeBaseId);
        nextToken = page.nextToken ?? undefined;
      } while (nextToken);
    } catch (e) {
      fail(`ListKnowledgeBases failed: ${e?.name ?? ''} ${e?.message ?? e}`);
    }
  }

  // ---- Report the teardown plan ----
  console.log('=== Teardown plan (reverse-dependency order) ===');
  console.log(`Workspace:        ${WORKSPACE_ID}`);
  console.log(`1. Deployments:   ${deploymentIds.length ? deploymentIds.join(', ') : '(none)'}`);
  console.log(`2. Application:   ${appName} ${applicationId ? `(${applicationId})` : '(not found)'} [cascades builds/deployments]`);
  console.log(`3. Flows:         ${flowIdsToDelete.length ? flowIdsToDelete.join(', ') : KEEP_FLOWS ? '(kept: --keep-flows)' : '(none)'}`);
  console.log(`4. Data requests: ${dataRequestIds.length ? dataRequestIds.join(', ') : '(none)'}`);
  console.log(`5. Knowledge bases: ${kbNames.length ? kbNames.map((n) => `${n}${kbIdByName.has(n) ? `(${kbIdByName.get(n)})` : '(not found)'}`).join(', ') : '(none)'}`);
  console.log(`6. Context vars:  ${contextVarNames.length ? contextVarNames.join(', ') : '(none)'}`);
  console.log(`7. Slot types:    ${slotTypeIds.length ? slotTypeIds.join(', ') : '(none)'}`);
  console.log(`8. Secrets:       ${DELETE_SECRETS ? (secretNames.length ? secretNames.join(', ') : '(none)') : 'kept (--keep-secrets)'}`);

  if (!CONFIRM) {
    console.log('\n\x1b[33mPreview only.\x1b[0m Nothing deleted. Re-run with --confirm to perform the deletions above.');
    return;
  }

  console.log('\n\x1b[31m--confirm set: performing deletions.\x1b[0m');

  // 1. Deployments (take the app offline before removing it).
  for (const deploymentId of deploymentIds) {
    await tryDelete(`deployment ${deploymentId}`, () =>
      client.send(new sdk.DeleteApplicationDeploymentCommand({ applicationIdentifier: applicationId, deploymentIdentifier: deploymentId })),
    );
  }

  // 2. Application (cascades its builds + deployments).
  if (applicationId) {
    await tryDelete(`application ${appName} (${applicationId})`, () =>
      client.send(new sdk.DeleteApplicationCommand({ applicationIdentifier: applicationId })),
    );
  }

  // 3. Flows (now detached).
  for (const flowId of flowIdsToDelete) {
    await tryDelete(`flow ${flowId}`, () => client.send(new sdk.DeleteFlowCommand({ flowIdentifier: flowId })));
  }

  // 4. Data requests.
  for (const id of dataRequestIds) {
    await tryDelete(`data request ${id}`, () => client.send(new sdk.DeleteDataRequestCommand({ dataRequestIdentifier: id })));
  }

  // 5. Knowledge bases (by id).
  for (const name of kbNames) {
    const id = kbIdByName.get(name);
    if (!id) {
      console.log(`  knowledge base ${name} not found, skipped`);
      continue;
    }
    await tryDelete(`knowledge base ${name} (${id})`, () => client.send(new sdk.DeleteKnowledgeBaseCommand({ knowledgeBaseId: id })));
  }

  // 6. Context variables.
  for (const name of contextVarNames) {
    await tryDelete(`context variable ${name}`, () => client.send(new sdk.DeleteContextVariableCommand({ contextVariableIdentifier: name })));
  }

  // 7. Slot types.
  for (const id of slotTypeIds) {
    await tryDelete(`slot type ${id}`, () => client.send(new sdk.DeleteSlotTypeCommand({ slotTypeIdentifier: id })));
  }

  // 8. Secrets (deleted by default; skipped with --keep-secrets).
  if (DELETE_SECRETS) {
    for (const name of secretNames) {
      await tryDelete(`secret ${name}`, () => client.send(new sdk.DeleteSecretCommand({ secretIdentifier: name })));
    }
  }

  if (deleteFailures.length) {
    console.error(`\n\x1b[31m${deleteFailures.length} delete(s) failed:\x1b[0m`);
    for (const f of deleteFailures) console.error(`  - ${f.label}: ${f.reason}`);
    console.error(
      '\nThe teardown continued past these so later resources (including secrets) still ran. ' +
        'Re-run after addressing the errors above; deletes are idempotent (already-gone resources are skipped).',
    );
    process.exit(1);
  }

  console.log('\n\x1b[32mDone.\x1b[0m ACXD resources torn down.');
}

main().catch((e) => fail(e?.stack ?? String(e)));
