/**
 * Knowledge base transform/deploy, document upload (presigned POST), and publish+poll.
 *
 * SDK references:
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-knowledge-bases.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-knowledge-base-documents.html
 *
 * Export wraps everything under `knowledgeBase` and keeps the response-tuning fields flat
 * (temperature, topP, minConfidenceScore, summarize). CreateKnowledgeBase takes those under
 * a `response` object instead, and does NOT accept knowledgeBaseId/path/tags on create.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESPONSE_FIELDS = ['summarize', 'minConfidenceScore', 'temperature', 'topP', 'k'];

/** Transform exported KB JSON into a CreateKnowledgeBase request. */
export function transformKnowledgeBase(exportedInput) {
  const kb = exportedInput?.knowledgeBase ?? exportedInput;
  if (!kb || typeof kb !== 'object') throw new Error('KB file did not parse to an object.');
  if (!kb.name) throw new Error('KB file is missing required "name".');
  if (!kb.type) throw new Error('KB file is missing required "type" (articles|documents).');

  const req = { name: kb.name, type: kb.type };
  if (kb.description != null) req.description = kb.description;
  if (kb.metadataSchema != null) req.metadataSchema = kb.metadataSchema;
  if (kb.metadata != null) req.metadata = kb.metadata;
  if (kb.languageCodes != null) req.languageCodes = kb.languageCodes;
  if (kb.mainLanguageCode != null) req.mainLanguageCode = kb.mainLanguageCode;
  else if (kb.masterLanguageCode != null) req.mainLanguageCode = kb.masterLanguageCode;

  // Fold flat response-tuning fields into the documented `response` object.
  const response = { ...(kb.response ?? {}) };
  for (const f of RESPONSE_FIELDS) {
    if (kb[f] != null && response[f] == null) response[f] = kb[f];
  }
  if (Object.keys(response).length) req.response = response;

  return req;
}

export function validateKnowledgeBase(req) {
  const problems = [];
  if (!/^[A-Za-z0-9 _-]{1,100}$/.test(req.name)) {
    problems.push(`name "${req.name}" must be alphanumeric + spaces/dashes/underscores, 1-100 chars.`);
  }
  if (!['articles', 'documents'].includes(req.type)) {
    problems.push(`type "${req.type}" must be "articles" or "documents".`);
  }
  if (req.description != null && req.description.length > 200) {
    problems.push('description exceeds 200 characters.');
  }
  const score = req.response?.minConfidenceScore;
  if (score != null && (score < 0 || score > 100)) {
    problems.push('response.minConfidenceScore must be 0-100.');
  }
  return problems;
}

/**
 * Deploy a KB (create-or-update, matched by name since the ID is server-assigned).
 * Returns { knowledgeBaseId, status }.
 */
export async function deployKnowledgeBase(client, commands, req, log = console.log) {
  const { ListKnowledgeBasesCommand, CreateKnowledgeBaseCommand, UpdateKnowledgeBaseCommand } =
    commands;

  let existingId = null;
  let nextToken;
  do {
    const page = await client.send(new ListKnowledgeBasesCommand({ nextToken }));
    const hit = (page.items ?? []).find((k) => k.name === req.name);
    if (hit) {
      existingId = hit.knowledgeBaseId;
      break;
    }
    nextToken = page.nextToken ?? undefined;
  } while (nextToken);

  if (existingId) {
    log(`  knowledge base "${req.name}": updating (already exists, ${existingId})`);
    const res = await client.send(
      new UpdateKnowledgeBaseCommand({ knowledgeBaseId: existingId, ...req }),
    );
    return { knowledgeBaseId: res?.knowledgeBaseId ?? existingId, status: 'updated' };
  }
  log(`  knowledge base "${req.name}": creating (new)`);
  const res = await client.send(new CreateKnowledgeBaseCommand(req));
  return { knowledgeBaseId: res?.knowledgeBaseId ?? null, status: 'created' };
}

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

function contentTypeFor(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Register a document and upload its bytes via the returned presigned POST.
 * `filePath` is a local file. Returns the documentId.
 */
export async function uploadKnowledgeBaseDocument(
  client,
  commands,
  { knowledgeBaseId, filePath, customerMetadata },
  log = console.log,
) {
  const { PutKnowledgeBaseDocumentCommand } = commands;
  const documentId = basename(filePath);
  const contentType = contentTypeFor(filePath);

  log(`  registering document "${documentId}" (${contentType})`);
  const reg = await client.send(
    new PutKnowledgeBaseDocumentCommand({
      knowledgeBaseId,
      documentId,
      contentType,
      ...(customerMetadata ? { customerMetadata } : {}),
    }),
  );

  if (!reg?.url) throw new Error('PutKnowledgeBaseDocument did not return an upload url.');

  // Presigned S3 POST: multipart/form-data with the returned fields, file last.
  const fileBytes = await readFile(filePath);
  const form = new FormData();
  for (const [k, v] of Object.entries(reg.fields ?? {})) form.append(k, v);
  form.append('file', new Blob([fileBytes], { type: contentType }), documentId);

  const resp = await fetch(reg.url, { method: 'POST', body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Presigned upload failed: HTTP ${resp.status} ${text.slice(0, 300)}`);
  }
  log(`  uploaded document "${documentId}"`);
  return documentId;
}

/**
 * Publish a KB and poll GetKnowledgeBasePublication until it settles.
 * Returns { deploymentId, status } where status is "published" or "failed".
 */
export async function publishKnowledgeBase(
  client,
  commands,
  { knowledgeBaseId, version, description },
  { pollIntervalMs = 5000, timeoutMs = 300000, log = console.log } = {},
) {
  const { PublishKnowledgeBaseCommand, GetKnowledgeBasePublicationCommand } = commands;

  const input = { knowledgeBaseId };
  if (version != null) input.version = version;
  if (description != null) input.description = description;

  const created = await client.send(new PublishKnowledgeBaseCommand(input));
  const deploymentId = created?.deploymentId;
  if (!deploymentId) throw new Error('PublishKnowledgeBase did not return a deploymentId.');
  log(`  publish ${deploymentId} started (status=${created?.status ?? 'scheduled'})`);

  const deadline = Date.now() + timeoutMs;
  let status = created?.status ?? 'scheduled';
  while (status === 'scheduled') {
    if (Date.now() > deadline) {
      throw new Error(`Publish ${deploymentId} did not finish within ${timeoutMs / 1000}s (last status ${status}).`);
    }
    await sleep(pollIntervalMs);
    const res = await client.send(
      new GetKnowledgeBasePublicationCommand({ knowledgeBaseId, deploymentId }),
    );
    status = res?.status ?? status;
    log(`  publish ${deploymentId} status=${status}`);
  }
  return { deploymentId, status };
}
