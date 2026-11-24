/**
 * Context variable transform, validation, and deploy logic.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-context-variables.html
 *
 * CreateContextVariable: name (required), schema, disallowExternalModification, metadata.
 * Export uses `key` for the name and carries workspace-only fields (`path`, `type`, `tags`).
 * There is no single Get operation, so idempotency is resolved via ListContextVariables.
 * Update uses `contextVariableIdentifier`.
 */

const NON_API_FIELDS = ['path', 'type', 'createdAt', 'updatedAt', 'updatedBy'];

export function transformContextVariable(exportedInput) {
  const exported = { ...exportedInput };
  for (const f of NON_API_FIELDS) delete exported[f];

  const name = exported.name ?? exported.key;
  if (!name) throw new Error('Context variable file is missing "key"/"name".');

  const req = { name };
  if (exported.schema != null) req.schema = exported.schema;
  if (exported.disallowExternalModification != null) {
    req.disallowExternalModification = exported.disallowExternalModification;
  }
  if (exported.metadata != null) req.metadata = exported.metadata;
  // Note: `tags` from the export is not a documented request field; if a tags-bearing
  // metadata is desired it must live under `metadata`. We drop a bare top-level tags.
  return req;
}

export function validateContextVariable(req) {
  const problems = [];
  // name: letters and underscores only, cannot start with nlx_context, max 64.
  if (!/^[A-Za-z_]{1,64}$/.test(req.name)) {
    problems.push(`name "${req.name}" must be letters/underscores only, max 64 chars.`);
  }
  if (/^nlx_context/i.test(req.name)) {
    problems.push(`name "${req.name}" must not start with "nlx_context".`);
  }
  if (req.schema != null && typeof req.schema === 'object') {
    const s = req.schema;
    const hasTop = 'type' in s || '$ref' in s || 'anyOf' in s;
    if (!hasTop) problems.push('schema must have at least one of: type, $ref, anyOf.');
  }
  return problems;
}

/** Deploy a context variable (create-or-update, idempotent via list). Returns status string. */
export async function deployContextVariable(client, commands, req, log = console.log) {
  const { ListContextVariablesCommand, CreateContextVariableCommand, UpdateContextVariableCommand } =
    commands;

  // No single Get; list and match by name. ListContextVariables takes no pagination params.
  let exists = false;
  try {
    const page = await client.send(new ListContextVariablesCommand({}));
    exists = (page.items ?? []).some((v) => v.name === req.name);
  } catch (e) {
    throw new Error(`ListContextVariables failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }

  try {
    if (exists) {
      log(`  context variable "${req.name}": updating (already exists)`);
      const { name, ...rest } = req;
      await client.send(new UpdateContextVariableCommand({ contextVariableIdentifier: name, ...rest }));
      return 'updated';
    }
    log(`  context variable "${req.name}": creating (new)`);
    await client.send(new CreateContextVariableCommand(req));
    return 'created';
  } catch (e) {
    if ((e?.name === 'ConflictException' || e?.$metadata?.httpStatusCode === 409) && !exists) {
      log(`  context variable "${req.name}": updating (created concurrently, retried as update)`);
      const { name, ...rest } = req;
      await client.send(new UpdateContextVariableCommand({ contextVariableIdentifier: name, ...rest }));
      return 'updated after conflict';
    }
    throw new Error(
      `Deploy context variable "${req.name}" failed: ${e?.name ?? ''} ${e?.message ?? e}`,
    );
  }
}
