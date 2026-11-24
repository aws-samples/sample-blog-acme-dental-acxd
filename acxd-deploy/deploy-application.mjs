#!/usr/bin/env node
/**
 * Deploy an exported Agentic CX Designer (ACXD) application JSON into a workspace via the
 * ACXD SDK.
 *
 * Idempotent: creates the application if none with the same name exists, otherwise updates
 * it in place (matched by name, since applicationId is server-assigned). Reads are
 * non-destructive; the only writes are the CreateApplication / UpdateApplication the user
 * asked for.
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node deploy-application.mjs ./applications/acme-dental.json
 *
 * Flags:
 *   --dry-run   Transform + validate the payload and print it, without calling the API.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-applications.html
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
  fail('Provide the path to an exported application JSON file. See usage in the file header.');
}
if (!DRY_RUN && !API_KEY) {
  fail('ACXD_API_KEY is not set. Export it or run with --dry-run.');
}
if (!DRY_RUN && !WORKSPACE_ID) {
  fail('ACXD_WORKSPACE_ID is not set. Export it or run with --dry-run.');
}

// ---------------------------------------------------------------------------
// Transform: exported application JSON -> CreateApplication / UpdateApplication payload
//
// Per the CreateApplication reference, the accepted params are:
//   name (required), settings (required), flows, description, metadata, deploymentSettings
//
// The workspace export carries several fields that are NOT request params (applicationId,
// tags, path, type, engine, interactionMode, instanceType) plus a settings.nluVersion that
// is not a documented setting. It also models attached conversations as "intents" and
// system routing as settings.defaultIntents keyed by NLX.* — whereas the API models these
// as "flows" and settings.defaultFlows keyed by welcome/fallback/unknown/escalation. In the
// NLX model an intent corresponds to a flow, so intentId maps to flowId.
// ---------------------------------------------------------------------------

/** Server-generated / read-only, must not be sent. */
const READ_ONLY_FIELDS = ['applicationId', 'createdAt', 'updatedAt', 'updatedBy'];

/** Top-level export fields that are not CreateApplication params (dropped). */
const NON_API_TOP_FIELDS = ['tags', 'path', 'type', 'engine', 'interactionMode', 'instanceType'];

/** settings fields not documented as Application Settings (dropped). */
const NON_API_SETTINGS_FIELDS = ['nluVersion'];

/** Documented Application Settings fields (allowlist) — anything else is dropped. */
const ALLOWED_SETTINGS = new Set([
  'languageCode',
  'languageCodes',
  'languageSettings',
  'defaultFlows',
  'guardrails',
  'lifecycleHooks',
  'thresholds',
  'conversationTTL',
  'autoCorrection',
  'childDirected',
  'repeatOnIncomprehension',
  'clusters',
]);

/** Documented languageSettings entry fields (allowlist). */
const ALLOWED_LANGUAGE_SETTING = new Set([
  'languageCode',
  'useNativeLanguage',
  'useLex3pAsr',
  'projectId',
  'voice',
]);

/** Map export defaultIntents keys (NLX.*) to API defaultFlows keys. */
const DEFAULT_FLOW_KEY_MAP = {
  'NLX.Welcome': 'welcome',
  'NLX.Fallback': 'fallback',
  'NLX.Unknown': 'unknown',
  'NLX.Escalation': 'escalation',
  'NLX.Frustration': 'frustration',
  'NLX.Help': 'help',
  'NLX.Repeat': 'repeat',
  'NLX.Resume': 'resume',
};

const mappingLog = [];

function transformSettings(exportedSettings) {
  const s = { ...(exportedSettings ?? {}) };

  // Drop undocumented settings.
  for (const f of NON_API_SETTINGS_FIELDS) {
    if (f in s) {
      delete s[f];
      mappingLog.push(`dropped settings.${f} (not a documented setting)`);
    }
  }

  // defaultIntents (NLX.* -> {intentId}) => defaultFlows (welcome/... -> {flowId}).
  if (s.defaultIntents && typeof s.defaultIntents === 'object') {
    const defaultFlows = { ...(s.defaultFlows ?? {}) };
    for (const [nlxKey, val] of Object.entries(s.defaultIntents)) {
      const apiKey = DEFAULT_FLOW_KEY_MAP[nlxKey];
      if (!apiKey) {
        mappingLog.push(`WARNING: unknown defaultIntents key "${nlxKey}" dropped`);
        continue;
      }
      const flowId = val?.flowId ?? val?.intentId;
      if (flowId == null) {
        mappingLog.push(`WARNING: defaultIntents.${nlxKey} has no intentId/flowId, dropped`);
        continue;
      }
      const mapped = { flowId };
      if (val.quickReplies != null) mapped.quickReplies = val.quickReplies;
      if (val.knowledgeBaseId != null) mapped.knowledgeBaseId = val.knowledgeBaseId;
      defaultFlows[apiKey] = mapped;
      mappingLog.push(`mapped defaultIntents.${nlxKey} -> defaultFlows.${apiKey} {flowId:"${flowId}"}`);
    }
    delete s.defaultIntents;
    s.defaultFlows = defaultFlows;
  }

  // Sanitize languageSettings entries to documented fields (export includes "region").
  if (Array.isArray(s.languageSettings)) {
    s.languageSettings = s.languageSettings.map((entry) => {
      const clean = {};
      for (const [k, v] of Object.entries(entry)) {
        if (ALLOWED_LANGUAGE_SETTING.has(k)) clean[k] = v;
        else mappingLog.push(`dropped settings.languageSettings[].${k} (not documented)`);
      }
      return clean;
    });
  }

  // Final allowlist pass on settings.
  const cleanSettings = {};
  for (const [k, v] of Object.entries(s)) {
    if (ALLOWED_SETTINGS.has(k)) cleanSettings[k] = v;
    else mappingLog.push(`dropped settings.${k} (not a documented setting)`);
  }
  return cleanSettings;
}

function transformDeploymentSettings(ds) {
  if (!ds || typeof ds !== 'object') return undefined;
  const out = {};
  if (ds.oneClickDeployEnabled != null) out.oneClickDeployEnabled = ds.oneClickDeployEnabled;
  if (ds.environment != null) out.environment = ds.environment;

  // export: contextVariables ; API: contextAttributes
  const ctx = ds.contextAttributes ?? ds.contextVariables;
  if (Array.isArray(ctx)) {
    out.contextAttributes = ctx;
    if (ds.contextVariables != null && ds.contextAttributes == null) {
      mappingLog.push('mapped deploymentSettings.contextVariables -> contextAttributes');
    }
  }
  if (ds.hosting != null) {
    mappingLog.push('dropped deploymentSettings.hosting (not a documented deployment setting)');
  }
  return out;
}

function transformExportToRequest(exported) {
  if (!exported || typeof exported !== 'object') {
    throw new Error('Application file did not parse to an object.');
  }
  if (!exported.name) {
    throw new Error('Application file is missing required "name".');
  }

  const req = {
    name: exported.name,
    settings: transformSettings(exported.settings),
  };

  if (exported.description != null && exported.description !== '') {
    req.description = exported.description;
  }
  if (exported.metadata != null) req.metadata = exported.metadata;

  // intents [{intentId}] => flows [{flowId}]
  if (Array.isArray(exported.flows)) {
    req.flows = exported.flows.map((f) => ({ flowId: f.flowId }));
  } else if (Array.isArray(exported.intents)) {
    req.flows = exported.intents.map((i) => ({ flowId: i.intentId }));
    mappingLog.push(
      `mapped intents -> flows: [${req.flows.map((f) => `"${f.flowId}"`).join(', ')}]`,
    );
  }

  const ds = transformDeploymentSettings(exported.deploymentSettings);
  if (ds) req.deploymentSettings = ds;

  return req;
}

/** Local validation mirroring documented constraints, to catch errors before the API round-trip. */
function validateRequest(req) {
  const problems = [];

  if (typeof req.name !== 'string' || req.name.length < 1 || req.name.length > 100) {
    problems.push('name must be 1-100 characters.');
  }
  if (req.description != null && req.description.length > 200) {
    problems.push('description exceeds 200 characters.');
  }
  if (!req.settings || typeof req.settings !== 'object') {
    problems.push('settings is required.');
  }

  const ttl = req.settings?.conversationTTL;
  if (ttl != null && (ttl < 1 || ttl > 60)) {
    problems.push('settings.conversationTTL must be 1-60 minutes.');
  }

  const validEnvs = new Set(['development', 'qa', 'staging', 'production']);
  const env = req.deploymentSettings?.environment;
  if (env != null && !validEnvs.has(env)) {
    problems.push(`deploymentSettings.environment "${env}" must be one of ${[...validEnvs].join(', ')}.`);
  }

  // Referential sanity: every defaultFlows target should be an attached flow.
  const flowIds = new Set((req.flows ?? []).map((f) => f.flowId));
  for (const [key, val] of Object.entries(req.settings?.defaultFlows ?? {})) {
    if (val?.flowId && flowIds.size && !flowIds.has(val.flowId)) {
      problems.push(`defaultFlows.${key} references flow "${val.flowId}" not attached in flows[].`);
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

  for (const f of READ_ONLY_FIELDS) delete exported[f];
  for (const f of NON_API_TOP_FIELDS) {
    if (f in exported) {
      delete exported[f];
      mappingLog.push(`dropped top-level "${f}" (not a request param)`);
    }
  }

  const request = transformExportToRequest(exported);

  const problems = validateRequest(request);
  if (mappingLog.length) {
    console.log('Transform notes:');
    for (const m of mappingLog) console.log(`  - ${m}`);
  }
  if (problems.length) {
    console.error('\x1b[31mValidation failed:\x1b[0m');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `Application "${request.name}" validated: ${request.flows?.length ?? 0} flow(s), ` +
      `${Object.keys(request.settings?.defaultFlows ?? {}).length} default flow route(s).`,
  );

  if (DRY_RUN) {
    console.log('\n--- Dry run: request payload (not sent) ---');
    console.log(JSON.stringify(request, null, 2));
    return;
  }

  let AgenticCXDesignerClient, CreateApplicationCommand, UpdateApplicationCommand, ListApplicationsCommand;
  try {
    ({
      AgenticCXDesignerClient,
      CreateApplicationCommand,
      UpdateApplicationCommand,
      ListApplicationsCommand,
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

  // Applications have server-assigned IDs, so match by name via ListApplications (paginated).
  let existingId = null;
  try {
    let nextToken;
    do {
      const page = await client.send(new ListApplicationsCommand({ nextToken }));
      const hit = (page.items ?? []).find((a) => a.name === request.name);
      if (hit) {
        existingId = hit.applicationId;
        break;
      }
      nextToken = page.nextToken ?? undefined;
    } while (nextToken);
  } catch (e) {
    fail(`ListApplications failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }

  try {
    if (existingId) {
      console.log(`Application "${request.name}": updating (already exists, ${existingId})`);
      const { name, ...rest } = request;
      const res = await client.send(
        new UpdateApplicationCommand({ applicationIdentifier: existingId, name, ...rest }),
      );
      console.log(`Updated. applicationId=${res?.applicationId ?? existingId} updatedAt=${res?.updatedAt ?? 'n/a'}`);
    } else {
      console.log(`Application "${request.name}": creating (new)`);
      const res = await client.send(new CreateApplicationCommand(request));
      console.log(`Created. applicationId=${res?.applicationId ?? 'n/a'} createdAt=${res?.createdAt ?? 'n/a'}`);
    }
  } catch (e) {
    fail(`Deploy failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }

  console.log('\x1b[32mDone.\x1b[0m Build + deploy the application to make changes live.');
}

main().catch((e) => fail(e?.stack ?? String(e)));
