/**
 * Data request transform, validation, and deploy logic.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-data-requests.html
 *
 * The data request webhook references secrets by name via {SecretName:NLX.Secret} tokens
 * inside the webhook config (url, header values). Those are plain string content — secrets
 * are referenced by name, so no ID remapping is needed, but the referenced secrets must
 * exist in the workspace first.
 *
 * Export keys the resource as `dataRequestId` and carries workspace-only fields
 * (`path`). CreateDataRequest keys on `dataRequestId` and takes webhook + schemas.
 */

const READ_ONLY_FIELDS = ['createdAt', 'updatedAt', 'lastUpdatedBy', 'updatedBy'];
const NON_API_FIELDS = ['path'];

/** Extract {Name:NLX.Secret} references from the webhook config (for ordering/validation). */
export function referencedSecrets(exportedInput) {
  const json = JSON.stringify(exportedInput ?? {});
  const names = new Set();
  const re = /\{([A-Za-z0-9_]+):NLX\.Secret\}/g;
  let m;
  while ((m = re.exec(json)) !== null) names.add(m[1]);
  return [...names];
}

export function transformDataRequest(exportedInput) {
  const exported = { ...exportedInput };
  for (const f of READ_ONLY_FIELDS) delete exported[f];
  for (const f of NON_API_FIELDS) delete exported[f];

  const dataRequestId = exported.dataRequestId ?? exported.name;
  if (!dataRequestId) throw new Error('Data request file is missing "dataRequestId".');

  const req = { dataRequestId };

  // CreateDataRequest requires `type` (the return type). The export's nested `type: "custom"`
  // is NOT this field. Infer from responseSchema: an object schema -> "object"; default "object".
  const VALID_TYPES = new Set(['text', 'number', 'boolean', 'list<text>', 'object', 'list<object>']);
  if (VALID_TYPES.has(exported.returnType)) {
    req.type = exported.returnType;
  } else if (exported.responseSchema?.type === 'object') {
    req.type = 'object';
  } else if (exported.responseSchema?.type === 'array') {
    req.type = 'list<object>';
  } else {
    req.type = 'object';
  }

  if (exported.webhook != null) req.webhook = exported.webhook;
  if (exported.description != null) req.description = exported.description;
  if (exported.sensitive != null) req.sensitive = exported.sensitive;
  if (exported.streamStateModifications != null) {
    req.streamStateModifications = exported.streamStateModifications;
  }
  if (exported.tags != null) req.tags = exported.tags;
  if (exported.requestSchema != null) req.requestSchema = exported.requestSchema;
  if (exported.responseSchema != null) req.responseSchema = exported.responseSchema;
  // Note: the export's `type` ("custom") is NOT the API's return-type field and must not be
  // forwarded; `type` is set above from returnType/responseSchema. All other fields are the
  // documented ones handled explicitly, so we do not blindly pass through unknown keys.
  return req;
}

export function validateDataRequest(req) {
  const problems = [];
  // dataRequestId: alphanumeric only, 3-100 chars.
  if (!/^[A-Za-z0-9]{3,100}$/.test(req.dataRequestId)) {
    problems.push(`dataRequestId "${req.dataRequestId}" must be alphanumeric, 3-100 chars.`);
  }
  const VALID_TYPES = new Set(['text', 'number', 'boolean', 'list<text>', 'object', 'list<object>']);
  if (!VALID_TYPES.has(req.type)) {
    problems.push(`type "${req.type}" must be one of ${[...VALID_TYPES].join(', ')}.`);
  }
  if (req.webhook == null) {
    problems.push('webhook is required (external integration config).');
  }
  if (req.description != null && req.description.length > 200) {
    problems.push('description exceeds 200 characters.');
  }
  return problems;
}

/** Deploy a data request (create-or-update, idempotent). Returns status string. */
export async function deployDataRequest(client, commands, req, log = console.log) {
  const { CreateDataRequestCommand, UpdateDataRequestCommand, GetDataRequestCommand } = commands;

  let exists = false;
  try {
    await client.send(new GetDataRequestCommand({ dataRequestIdentifier: req.dataRequestId }));
    exists = true;
  } catch (e) {
    if (e?.name !== 'ResourceNotFoundException' && e?.$metadata?.httpStatusCode !== 404) {
      throw new Error(`GetDataRequest failed: ${e?.name ?? ''} ${e?.message ?? e}`);
    }
  }

  try {
    if (exists) {
      log(`  data request "${req.dataRequestId}": updating (already exists)`);
      const { dataRequestId, ...rest } = req;
      await client.send(new UpdateDataRequestCommand({ dataRequestIdentifier: dataRequestId, ...rest }));
      return 'updated';
    }
    log(`  data request "${req.dataRequestId}": creating (new)`);
    await client.send(new CreateDataRequestCommand(req));
    return 'created';
  } catch (e) {
    if ((e?.name === 'ConflictException' || e?.$metadata?.httpStatusCode === 409) && !exists) {
      log(`  data request "${req.dataRequestId}": updating (created concurrently, retried as update)`);
      const { dataRequestId, ...rest } = req;
      await client.send(new UpdateDataRequestCommand({ dataRequestIdentifier: dataRequestId, ...rest }));
      return 'updated after conflict';
    }
    throw new Error(
      `Deploy data request "${req.dataRequestId}" failed: ${e?.name ?? ''} ${e?.message ?? e}`,
    );
  }
}
