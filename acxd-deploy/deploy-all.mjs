#!/usr/bin/env node
/**
 * Orchestrated ACXD deploy. Deploys every resource type in dependency order so references
 * resolve and the application build won't fail:
 *
 *   secrets (optional, interactive)
 *     -> slot types, context variables, knowledge bases (+document upload +publish)
 *       -> data requests
 *         -> flows   (with Option B knowledge-base UUID rewrite)
 *           -> application
 *             -> build -> deploy
 *
 * Option B (KB UUID rewrite): the exported flow references the knowledge base by a hardcoded
 * UUID. Knowledge bases get a NEW server-assigned id on create, so after deploying each KB we
 * capture its real id and substitute it into any flow tool reference whose knowledgeBaseId no
 * longer exists, keyed by the KB name mentioned in the generative-journey prompt. For a single
 * KB (this project) the sole deployed KB id replaces the sole KB tool reference.
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node deploy-all.mjs [flags]
 *
 * Flags:
 *   --app <path>              Application JSON (default: applications/acme-dental.json)
 *   --flows-dir <path>        Flow JSON directory (default: flows)
 *   --slot-types-dir <path>   Slot type JSON directory (default: slot-types)
 *   --context-vars-dir <path> Context variable JSON directory (default: context-variables)
 *   --kb-dir <path>           Knowledge base root (default: knowledge-bases; each subfolder has knowledge-base.json + documents/)
 *   --data-requests-dir <path> Data request JSON directory (default: data-requests)
 *   --secrets <path>          Also deploy secrets from this manifest first (interactive prompt)
 *   --no-publish-kb           Do NOT publish knowledge bases (they are published by default)
 *   --only-referenced-flows   Only deploy flows the app references
 *   --build                   Build the application after resources land (no deploy)
 *   --deploy                  Build then deploy the build (implies --build)
 *   --environment <env>       Target environment for --deploy (default: development)
 *   --dry-run                 Transform + validate + print the plan, without calling the API
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import { transformFlow, validateFlow, deployFlow } from './lib/flow.mjs';
import { transformApplication, validateApplication, deployApplication } from './lib/application.mjs';
import { buildApplication, deployBuild } from './lib/build-deploy.mjs';
import { transformSlotType, validateSlotType, deploySlotType } from './lib/slot-type.mjs';
import {
  transformContextVariable,
  validateContextVariable,
  deployContextVariable,
} from './lib/context-variable.mjs';
import {
  transformKnowledgeBase,
  validateKnowledgeBase,
  deployKnowledgeBase,
  uploadKnowledgeBaseDocument,
  publishKnowledgeBase,
} from './lib/knowledge-base.mjs';
import {
  transformDataRequest,
  validateDataRequest,
  deployDataRequest,
  referencedSecrets,
} from './lib/data-request.mjs';
import {
  promptSecret,
  validateSecretName,
  deploySecret,
  listExistingSecretNames,
} from './lib/secret.mjs';
import { existsSync } from 'node:fs';

const API_KEY = process.env.ACXD_API_KEY;
const WORKSPACE_ID = process.env.ACXD_WORKSPACE_ID;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY_REFERENCED = args.includes('--only-referenced-flows');
const DO_DEPLOY = args.includes('--deploy');
const DO_BUILD = args.includes('--build') || DO_DEPLOY;
// Knowledge bases are published by default (a documents-type KB is unusable until published).
// Pass --no-publish-kb to deploy/upload the KB without publishing it.
const PUBLISH_KB = !args.includes('--no-publish-kb');

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
// Secrets are deployed by default when the manifest exists; --no-secrets opts out.
// --secrets <path> overrides the manifest location (default secrets/secrets.json).
const NO_SECRETS = args.includes('--no-secrets');
const SECRETS_PATH = flagValue('--secrets', 'secrets/secrets.json');
const ENVIRONMENT = flagValue('--environment', 'development');

const VALID_ENVS = new Set(['development', 'qa', 'staging', 'production']);

function fail(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

// Per-resource outcome counts for the end-of-run summary. Any failure exits via fail(),
// so a run that reaches the summary has no failed resources.
const summary = { created: 0, updated: 0, skipped: 0 };

/** Count a deployX status ("created ...", "updated ...", "updated after conflict ..."). */
function tally(status) {
  const s = String(status);
  if (s.startsWith('created')) summary.created += 1;
  else if (s.startsWith('updated')) summary.updated += 1;
}

function printSummary() {
  console.log(
    `\nSummary: created ${summary.created}, updated ${summary.updated}, ` +
      `skipped ${summary.skipped}, failed 0`,
  );
}

if (!DRY_RUN && !API_KEY) fail('ACXD_API_KEY is not set. Export it or run with --dry-run.');
if (!DRY_RUN && !WORKSPACE_ID) fail('ACXD_WORKSPACE_ID is not set. Export it or run with --dry-run.');
if (DO_DEPLOY && !VALID_ENVS.has(ENVIRONMENT)) {
  fail(`--environment "${ENVIRONMENT}" must be one of ${[...VALID_ENVS].join(', ')}.`);
}

async function readJson(path) {
  const abs = resolve(path);
  const raw = await readFile(abs, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse JSON in ${abs}: ${e.message}`);
  }
}

/** List *.json files in a directory (empty if the dir does not exist). */
async function listJson(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Discover KB folders under kbRoot: each subfolder with a knowledge-base.json. */
async function listKnowledgeBases(kbRoot) {
  let entries;
  try {
    entries = await readdir(kbRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const kbs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const kbJson = join(kbRoot, e.name, 'knowledge-base.json');
    try {
      await readFile(kbJson, 'utf8');
      kbs.push({ dir: join(kbRoot, e.name), file: kbJson });
    } catch {
      // skip folders without a knowledge-base.json
    }
  }
  return kbs;
}

/**
 * Option B: rewrite a flow's knowledge-base tool references to deployed KB ids.
 * `kbIdByName` maps KB name -> new id; `deployedIds` is the set of ids now valid.
 * For a knowledgeBase tool whose knowledgeBaseId is not in deployedIds, substitute:
 *   - if the generative-journey prompt mentions a KB name we deployed, use that id;
 *   - else if exactly one KB was deployed, use it.
 * Returns the number of references rewritten.
 */
function rewriteFlowKnowledgeBaseIds(flowReq, kbIdByName, deployedIds) {
  let rewrites = 0;
  const nodes = flowReq.nodes ?? {};
  const allNames = [...kbIdByName.keys()];
  const soleId = deployedIds.size === 1 ? [...deployedIds][0] : null;

  for (const node of Object.values(nodes)) {
    const gj = node?.metadata?.generativeJourney;
    const tools = gj?.tools;
    if (!Array.isArray(tools)) continue;
    const prompt = gj.prompt ?? '';
    for (const tool of tools) {
      if (tool?.type !== 'knowledgeBase') continue;
      if (tool.knowledgeBaseId && deployedIds.has(tool.knowledgeBaseId)) continue; // already valid
      // Prefer a KB name mentioned in the prompt.
      let targetId = null;
      const mentioned = allNames.find((n) => prompt.includes(n));
      if (mentioned) targetId = kbIdByName.get(mentioned);
      else if (soleId) targetId = soleId;
      if (targetId) {
        tool.knowledgeBaseId = targetId;
        rewrites += 1;
      }
    }
  }
  return rewrites;
}

async function main() {
  // ---- Load + transform everything (fail fast on validation before any API call) ----
  const appExport = await readJson(APP_PATH);
  const { request: appReq, mappingLog } = transformApplication(appExport);
  const appProblems = validateApplication(appReq);

  // Flows
  const flowFiles = await listJson(FLOWS_DIR);
  const allFlows = new Map();
  for (const file of flowFiles) {
    const req = transformFlow(await readJson(file));
    allFlows.set(req.flowId, { file, req });
  }
  const referenced = new Set((appReq.flows ?? []).map((f) => f.flowId));
  const flowsToDeploy = [];
  const missingReferenced = [];
  for (const flowId of referenced) {
    if (allFlows.has(flowId)) flowsToDeploy.push(allFlows.get(flowId));
    else missingReferenced.push(flowId);
  }
  if (!ONLY_REFERENCED) {
    for (const [flowId, entry] of allFlows) if (!referenced.has(flowId)) flowsToDeploy.push(entry);
  }

  // Slot types
  const slotTypes = [];
  for (const file of await listJson(SLOT_TYPES_DIR)) {
    slotTypes.push({ file, req: transformSlotType(await readJson(file)) });
  }

  // Context variables
  const contextVars = [];
  for (const file of await listJson(CONTEXT_VARS_DIR)) {
    contextVars.push({ file, req: transformContextVariable(await readJson(file)) });
  }

  // Knowledge bases (+ their document folders)
  const knowledgeBases = [];
  for (const { dir, file } of await listKnowledgeBases(KB_DIR)) {
    const req = transformKnowledgeBase(await readJson(file));
    const docFiles = (await listRawFiles(join(dir, 'documents')));
    knowledgeBases.push({ dir, file, req, docFiles });
  }

  // Data requests
  const dataRequests = [];
  for (const file of await listJson(DATA_REQUESTS_DIR)) {
    const raw = await readJson(file);
    dataRequests.push({ file, raw, req: transformDataRequest(raw), secrets: referencedSecrets(raw) });
  }

  // Secrets manifest: deployed by default when it exists, unless --no-secrets.
  // An explicitly-passed --secrets path that is missing is an error; the default path
  // simply being absent is not (secrets are then skipped).
  const secretsPathExplicit = args.includes('--secrets');
  let secretsManifest = null;
  if (!NO_SECRETS) {
    if (existsSync(SECRETS_PATH)) {
      const m = await readJson(SECRETS_PATH);
      if (!Array.isArray(m?.secrets) || m.secrets.length === 0) {
        fail(`Secrets manifest ${SECRETS_PATH} must contain a non-empty "secrets" array.`);
      }
      secretsManifest = m.secrets;
    } else if (secretsPathExplicit) {
      fail(`Secrets manifest not found: ${SECRETS_PATH}`);
    }
  }

  // ---- Validate everything ----
  const problems = [];
  for (const { file, req } of slotTypes) for (const p of validateSlotType(req)) problems.push(`[slot ${file}] ${p}`);
  for (const { file, req } of contextVars) for (const p of validateContextVariable(req)) problems.push(`[ctx ${file}] ${p}`);
  for (const { file, req } of knowledgeBases) for (const p of validateKnowledgeBase(req)) problems.push(`[kb ${file}] ${p}`);
  for (const { file, req } of dataRequests) for (const p of validateDataRequest(req)) problems.push(`[dr ${file}] ${p}`);
  for (const { file, req } of flowsToDeploy) for (const p of validateFlow(req)) problems.push(`[flow ${file}] ${p}`);
  for (const p of appProblems) problems.push(`[app] ${p}`);
  if (secretsManifest) {
    for (const s of secretsManifest) {
      if (!s.name || !validateSecretName(s.name)) problems.push(`[secret] invalid name "${s.name}"`);
      if ('secretValue' in s || 'value' in s) problems.push(`[secret] "${s.name}" must not contain a value in the manifest`);
    }
  }

  // Cross-resource reference checks.
  if (missingReferenced.length) {
    problems.push(`application references flow(s) with no JSON in "${FLOWS_DIR}": ${missingReferenced.join(', ')}`);
  }
  // Secrets referenced by data requests should be deployable (manifest) or assumed pre-existing.
  const drSecrets = new Set(dataRequests.flatMap((d) => d.secrets));
  const manifestSecretNames = new Set((secretsManifest ?? []).map((s) => s.name));
  const secretsNotInManifest = [...drSecrets].filter((s) => !manifestSecretNames.has(s));

  // ---- Report plan ----
  console.log('=== Deploy plan (dependency order) ===');
  console.log(`Workspace:        ${WORKSPACE_ID ?? '(dry-run)'}`);
  if (secretsManifest) {
    console.log(
      `1. Secrets:       ${secretsManifest.map((s) => s.name).join(', ')} ` +
        '(prompts only for secrets not already in the workspace)',
    );
  } else if (NO_SECRETS) {
    console.log('1. Secrets:       skipped (--no-secrets)');
  } else {
    console.log(`1. Secrets:       skipped (no manifest at ${SECRETS_PATH})`);
  }
  console.log(`2. Slot types:    ${slotTypes.map((s) => s.req.slotTypeId).join(', ') || '(none)'}`);
  console.log(`3. Context vars:  ${contextVars.map((c) => c.req.name).join(', ') || '(none)'}`);
  console.log(
    `4. Knowledge bases: ${knowledgeBases.map((k) => `${k.req.name}(${k.docFiles.length} doc${k.docFiles.length === 1 ? '' : 's'})`).join(', ') || '(none)'}` +
      (PUBLISH_KB ? ' [will publish]' : ' [not publishing: --no-publish-kb]'),
  );
  console.log(`5. Data requests: ${dataRequests.map((d) => d.req.dataRequestId).join(', ') || '(none)'}`);
  console.log(`6. Flows:         ${flowsToDeploy.map((f) => f.req.flowId).join(', ') || '(none)'} (KB UUID rewrite applied)`);
  console.log(`7. Application:   ${appReq.name}`);
  if (DO_DEPLOY) console.log(`8. Build -> deploy to "${ENVIRONMENT}"`);
  else if (DO_BUILD) console.log('8. Build (no deploy)');
  else console.log('8. Build/deploy:  skipped (--build / --deploy)');
  if (mappingLog.length) {
    console.log('Application transform notes:');
    for (const m of mappingLog) console.log(`  - ${m}`);
  }
  if (secretsNotInManifest.length) {
    console.log(
      `Note: data requests reference secret(s) not in a manifest: ${secretsNotInManifest.join(', ')}. ` +
        'They must already exist in the workspace (or pass --secrets to create them).',
    );
  }

  if (problems.length) {
    console.error('\x1b[31mValidation failed:\x1b[0m');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\x1b[32mAll resources validated.\x1b[0m');

  if (DRY_RUN) {
    console.log('\nDry run: nothing sent.');
    return;
  }

  // ---- Load SDK ----
  let sdk;
  try {
    sdk = await import('amazon-connect-acxd-sdk');
  } catch (e) {
    fail(`Could not load "amazon-connect-acxd-sdk". Run "npm install" first, or use --dry-run. (${e.message})`);
  }
  const client = new sdk.AgenticCXDesignerClient({ apiKey: API_KEY, workspaceId: WORKSPACE_ID });

  // ---- 1. Secrets ----
  // Only prompt for secrets that do NOT already exist in the workspace, so re-deploys run
  // unattended. Existing secrets are left as-is (re-run deploy-secrets.mjs to rotate a value).
  if (secretsManifest) {
    console.log('\n=== 1. Secrets ===');
    const existing = await listExistingSecretNames(client, sdk);
    const missing = secretsManifest.filter((s) => !existing.has(s.name));
    const present = secretsManifest.filter((s) => existing.has(s.name));
    for (const s of present) {
      console.log(`  ${s.name}: already exists, skipped`);
      summary.skipped += 1;
    }

    if (missing.length === 0) {
      console.log('  all manifest secrets already exist — no prompt needed.');
    } else {
      console.log(`\nEnter a value for each NEW secret (input hidden). Leave blank to skip.\n`);
    }
    for (const s of missing) {
      const value = await promptSecret(`  ${s.name}: `);
      if (!value) {
        console.log(`  skipped "${s.name}" (no value entered)`);
        summary.skipped += 1;
        continue;
      }
      const status = await deploySecret(client, sdk, {
        name: s.name,
        secretValue: value,
        description: s.description,
        isSensitive: s.isSensitive,
      });
      console.log(`  ${s.name}: ${status}`);
      tally(status);
    }
  }

  // ---- 2. Slot types ----
  if (slotTypes.length) {
    console.log('\n=== 2. Slot types ===');
    for (const { req } of slotTypes) {
      const status = await deploySlotType(client, sdk, req);
      console.log(`  ${req.slotTypeId}: ${status}`);
      tally(status);
    }
  }

  // ---- 3. Context variables ----
  if (contextVars.length) {
    console.log('\n=== 3. Context variables ===');
    for (const { req } of contextVars) {
      const status = await deployContextVariable(client, sdk, req);
      console.log(`  ${req.name}: ${status}`);
      tally(status);
    }
  }

  // ---- 4. Knowledge bases (+ docs, + optional publish). Capture new ids for Option B. ----
  const kbIdByName = new Map();
  const deployedKbIds = new Set();
  if (knowledgeBases.length) {
    console.log('\n=== 4. Knowledge bases ===');
    for (const { req, docFiles } of knowledgeBases) {
      const { knowledgeBaseId, status } = await deployKnowledgeBase(client, sdk, req);
      console.log(`  ${req.name}: ${status} (knowledgeBaseId=${knowledgeBaseId ?? 'n/a'})`);
      if (!knowledgeBaseId) fail(`No knowledgeBaseId returned for "${req.name}".`);
      tally(status);
      kbIdByName.set(req.name, knowledgeBaseId);
      deployedKbIds.add(knowledgeBaseId);
      for (const f of docFiles) {
        await uploadKnowledgeBaseDocument(client, sdk, { knowledgeBaseId, filePath: f });
      }
      if (PUBLISH_KB) {
        const pub = await publishKnowledgeBase(client, sdk, {
          knowledgeBaseId,
          version: '1.0',
          description: `Automated publish of ${req.name}`,
        });
        if (pub.status !== 'published') fail(`KB "${req.name}" publish status "${pub.status}" (expected published).`);
        console.log(`  ${req.name}: published (deploymentId=${pub.deploymentId})`);
      }
    }
  }

  // ---- 5. Data requests ----
  if (dataRequests.length) {
    console.log('\n=== 5. Data requests ===');
    for (const { req } of dataRequests) {
      const status = await deployDataRequest(client, sdk, req);
      console.log(`  ${req.dataRequestId}: ${status}`);
      tally(status);
    }
  }

  // ---- 6. Flows (apply Option B KB UUID rewrite before deploy) ----
  console.log('\n=== 6. Flows ===');
  for (const { req } of flowsToDeploy) {
    const n = rewriteFlowKnowledgeBaseIds(req, kbIdByName, deployedKbIds);
    if (n) console.log(`  (rewrote ${n} knowledge-base reference(s) in ${req.flowId} to deployed id)`);
    const status = await deployFlow(client, sdk, req);
    console.log(`  ${req.flowId}: ${status}`);
    tally(status);
  }

  // ---- 7. Application ----
  console.log('\n=== 7. Application ===');
  let applicationId = null;
  {
    const res = await deployApplication(client, sdk, appReq);
    applicationId = res.applicationId;
    console.log(`  ${appReq.name}: ${res.status} (applicationId=${applicationId ?? 'n/a'})`);
    tally(res.status);
  }

  if (!DO_BUILD) {
    printSummary();
    console.log('\n\x1b[32mDone.\x1b[0m All resources deployed. Re-run with --build or --deploy to go live.');
    return;
  }
  if (!applicationId) fail('Cannot build: the deploy step did not return an applicationId.');

  // ---- 8. Build ----
  console.log('\n=== 8. Building application ===');
  const languageCodes = appReq.settings?.languageCodes ?? undefined;
  let buildId;
  {
    const res = await buildApplication(client, sdk, {
      applicationId,
      description: `Automated build of ${appReq.name}`,
      languageSettings: appReq.settings?.languageSettings,
    });
    buildId = res.buildId;
    if (res.status !== 'BUILT') {
      fail(`Build ${buildId} finished "${res.status}" (expected BUILT). A FAILED build usually means an unresolved reference. Not deploying.`);
    }
    console.log(`  build ${buildId}: ${res.status}`);
  }

  if (!DO_DEPLOY) {
    printSummary();
    console.log(`\n\x1b[32mDone.\x1b[0m ${appReq.name} built (buildId=${buildId}), not deployed. Re-run with --deploy.`);
    return;
  }

  // ---- Deploy build ----
  console.log(`\n=== Deploying build to "${ENVIRONMENT}" ===`);
  {
    const res = await deployBuild(client, sdk, {
      applicationId,
      buildId,
      environment: ENVIRONMENT,
      languageCodes,
      description: `Automated deploy of ${appReq.name} to ${ENVIRONMENT}`,
    });
    if (res.status !== 'deployed') fail(`Deployment ${res.deploymentId} finished "${res.status}" (expected deployed).`);
    console.log(`  deployment ${res.deploymentId}: ${res.status}`);
  }

  printSummary();
  console.log(`\n\x1b[32mDone.\x1b[0m ${appReq.name} is built and deployed to "${ENVIRONMENT}".`);
}

/** List non-dotfiles in a dir as full paths (empty if missing). */
async function listRawFiles(dir) {
  try {
    return (await readdir(dir)).filter((f) => !f.startsWith('.')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
