/**
 * Slot type transform, validation, and deploy logic.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-slot-types.html
 *
 * Export shape uses `slotId` + `masterLanguageCode` and carries UI/workspace-only fields
 * (`path`, `type`, `mirroring`, per-value `translated`). The CreateSlotType request uses
 * `slotTypeId` + `mainLanguageCode` and the documented Slot Type Value fields
 * (value, valueId?, synonyms?, skipTraining?, skipTranslation?, choicePayload?).
 */

const READ_ONLY_FIELDS = ['createdAt', 'updatedAt', 'lastUpdatedBy'];
const NON_API_FIELDS = ['path', 'type', 'mirroring'];
const ALLOWED_VALUE_FIELDS = new Set([
  'value',
  'valueId',
  'synonyms',
  'skipTraining',
  'skipTranslation',
  'choicePayload',
]);

export function transformSlotType(exportedInput) {
  const exported = { ...exportedInput };
  for (const f of READ_ONLY_FIELDS) delete exported[f];
  for (const f of NON_API_FIELDS) delete exported[f];

  const slotTypeId = exported.slotTypeId ?? exported.slotId;
  if (!slotTypeId) throw new Error('Slot type file is missing "slotId"/"slotTypeId".');
  if (!Array.isArray(exported.values)) {
    throw new Error(`Slot type "${slotTypeId}" is missing required "values" array.`);
  }

  const req = {
    slotTypeId,
    values: exported.values.map((v) => {
      const clean = {};
      for (const [k, val] of Object.entries(v)) {
        if (ALLOWED_VALUE_FIELDS.has(k)) clean[k] = val;
      }
      return clean;
    }),
  };

  if (exported.sensitive != null) req.sensitive = exported.sensitive;
  if (exported.description != null) req.description = exported.description;
  if (exported.languageCodes != null) req.languageCodes = exported.languageCodes;
  if (exported.metadata != null) req.metadata = exported.metadata;
  if (exported.mainLanguageCode != null) req.mainLanguageCode = exported.mainLanguageCode;
  else if (exported.masterLanguageCode != null) req.mainLanguageCode = exported.masterLanguageCode;

  return req;
}

export function validateSlotType(req) {
  const problems = [];
  // slotTypeId: alphabetic only, 3-100 chars.
  if (!/^[A-Za-z]{3,100}$/.test(req.slotTypeId)) {
    problems.push(`slotTypeId "${req.slotTypeId}" must be alphabetic only, 3-100 chars.`);
  }
  if (!req.values.length) problems.push('values is empty.');
  for (const v of req.values) {
    if (typeof v.value !== 'string' || v.value.length < 1 || v.value.length > 256) {
      problems.push(`value "${v.value}" must be 1-256 chars.`);
    }
    if (v.choicePayload != null && v.choicePayload.length > 200) {
      problems.push(`choicePayload for "${v.value}" exceeds 200 chars.`);
    }
  }
  if (req.description != null && req.description.length > 200) {
    problems.push('description exceeds 200 characters.');
  }
  return problems;
}

/** Deploy a slot type (create-or-update, idempotent). Returns a status string. */
export async function deploySlotType(client, commands, req, log = console.log) {
  const { CreateSlotTypeCommand, UpdateSlotTypeCommand, GetSlotTypeCommand } = commands;

  let exists = false;
  try {
    await client.send(new GetSlotTypeCommand({ slotTypeIdentifier: req.slotTypeId }));
    exists = true;
  } catch (e) {
    if (e?.name !== 'ResourceNotFoundException' && e?.$metadata?.httpStatusCode !== 404) {
      throw new Error(`GetSlotType failed: ${e?.name ?? ''} ${e?.message ?? e}`);
    }
  }

  try {
    if (exists) {
      log(`  slot type "${req.slotTypeId}": updating (already exists)`);
      const { slotTypeId, ...rest } = req;
      await client.send(new UpdateSlotTypeCommand({ slotTypeIdentifier: slotTypeId, ...rest }));
      return 'updated';
    }
    log(`  slot type "${req.slotTypeId}": creating (new)`);
    await client.send(new CreateSlotTypeCommand(req));
    return 'created';
  } catch (e) {
    if ((e?.name === 'ConflictException' || e?.$metadata?.httpStatusCode === 409) && !exists) {
      log(`  slot type "${req.slotTypeId}": updating (created concurrently, retried as update)`);
      const { slotTypeId, ...rest } = req;
      await client.send(new UpdateSlotTypeCommand({ slotTypeIdentifier: slotTypeId, ...rest }));
      return 'updated after conflict';
    }
    throw new Error(`Deploy slot type "${req.slotTypeId}" failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }
}
