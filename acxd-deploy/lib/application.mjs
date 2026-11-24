/**
 * Application transform, validation, and deploy logic shared by deploy-application.mjs and
 * deploy-all.mjs.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-applications.html
 */

const READ_ONLY_FIELDS = ['applicationId', 'createdAt', 'updatedAt', 'updatedBy'];
const NON_API_TOP_FIELDS = ['tags', 'path', 'type', 'engine', 'interactionMode', 'instanceType'];
const NON_API_SETTINGS_FIELDS = ['nluVersion'];

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

const ALLOWED_LANGUAGE_SETTING = new Set([
  'languageCode',
  'useNativeLanguage',
  'useLex3pAsr',
  'projectId',
  'voice',
]);

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

function transformSettings(exportedSettings, mappingLog) {
  const s = { ...(exportedSettings ?? {}) };

  for (const f of NON_API_SETTINGS_FIELDS) {
    if (f in s) {
      delete s[f];
      mappingLog.push(`dropped settings.${f} (not a documented setting)`);
    }
  }

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

  const cleanSettings = {};
  for (const [k, v] of Object.entries(s)) {
    if (ALLOWED_SETTINGS.has(k)) cleanSettings[k] = v;
    else mappingLog.push(`dropped settings.${k} (not a documented setting)`);
  }
  return cleanSettings;
}

function transformDeploymentSettings(ds, mappingLog) {
  if (!ds || typeof ds !== 'object') return undefined;
  const out = {};
  if (ds.oneClickDeployEnabled != null) out.oneClickDeployEnabled = ds.oneClickDeployEnabled;
  if (ds.environment != null) out.environment = ds.environment;

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

/**
 * Transform an exported application object into a CreateApplication / UpdateApplication
 * request. Returns { request, mappingLog }.
 */
export function transformApplication(exportedInput) {
  const exported = { ...exportedInput };
  const mappingLog = [];

  for (const f of READ_ONLY_FIELDS) delete exported[f];
  for (const f of NON_API_TOP_FIELDS) {
    if (f in exported) {
      delete exported[f];
      mappingLog.push(`dropped top-level "${f}" (not a request param)`);
    }
  }

  if (!exported.name) {
    throw new Error('Application file is missing required "name".');
  }

  const request = {
    name: exported.name,
    settings: transformSettings(exported.settings, mappingLog),
  };

  if (exported.description != null && exported.description !== '') {
    request.description = exported.description;
  }
  if (exported.metadata != null) request.metadata = exported.metadata;

  if (Array.isArray(exported.flows)) {
    request.flows = exported.flows.map((f) => ({ flowId: f.flowId }));
  } else if (Array.isArray(exported.intents)) {
    request.flows = exported.intents.map((i) => ({ flowId: i.intentId }));
    mappingLog.push(
      `mapped intents -> flows: [${request.flows.map((f) => `"${f.flowId}"`).join(', ')}]`,
    );
  }

  const ds = transformDeploymentSettings(exported.deploymentSettings, mappingLog);
  if (ds) request.deploymentSettings = ds;

  return { request, mappingLog };
}

/** Validate an application request against documented constraints. Returns array of problems. */
export function validateApplication(req) {
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

  const flowIds = new Set((req.flows ?? []).map((f) => f.flowId));
  for (const [key, val] of Object.entries(req.settings?.defaultFlows ?? {})) {
    if (val?.flowId && flowIds.size && !flowIds.has(val.flowId)) {
      problems.push(`defaultFlows.${key} references flow "${val.flowId}" not attached in flows[].`);
    }
  }

  return problems;
}

/**
 * Deploy an application request via the SDK client (create-or-update by name, idempotent).
 * `commands` is the imported SDK command set. Returns a short status string.
 */
export async function deployApplication(client, commands, req, log = console.log) {
  const { CreateApplicationCommand, UpdateApplicationCommand, ListApplicationsCommand } = commands;

  let existingId = null;
  let nextToken;
  do {
    const page = await client.send(new ListApplicationsCommand({ nextToken }));
    const hit = (page.items ?? []).find((a) => a.name === req.name);
    if (hit) {
      existingId = hit.applicationId;
      break;
    }
    nextToken = page.nextToken ?? undefined;
  } while (nextToken);

  if (existingId) {
    log(`  application "${req.name}": updating (already exists, ${existingId})`);
    const { name, ...rest } = req;
    const res = await client.send(
      new UpdateApplicationCommand({ applicationIdentifier: existingId, name, ...rest }),
    );
    return { applicationId: res?.applicationId ?? existingId, status: 'updated' };
  }
  log(`  application "${req.name}": creating (new)`);
  const res = await client.send(new CreateApplicationCommand(req));
  return { applicationId: res?.applicationId ?? null, status: 'created' };
}
