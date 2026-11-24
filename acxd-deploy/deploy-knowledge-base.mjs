#!/usr/bin/env node
/**
 * Deploy an exported ACXD knowledge base: create/update, upload documents, optionally publish.
 *
 * Looks for a `documents/` folder next to the KB JSON and uploads every file in it.
 * (For a `documents`-type KB with no files, it warns and continues.)
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node deploy-knowledge-base.mjs knowledge-bases/AcmeInsuranceKB/knowledge-base.json [--publish] [--dry-run]
 *
 * Flags:
 *   --publish    After upload, publish the KB and poll until published/failed.
 *   --dry-run    Transform + validate + print, without calling the API.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-knowledge-bases.html
 */
import { readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fail, parseArgs, readJson, loadSdk, requireCreds } from './lib/cli.mjs';
import {
  transformKnowledgeBase,
  validateKnowledgeBase,
  deployKnowledgeBase,
  uploadKnowledgeBaseDocument,
  publishKnowledgeBase,
} from './lib/knowledge-base.mjs';

const { args, dryRun, positional: filePath } = parseArgs();
const doPublish = args.includes('--publish');
if (!filePath) fail('Provide the path to an exported knowledge base JSON file.');

const creds = dryRun ? {} : requireCreds();

const req = transformKnowledgeBase(await readJson(filePath));
const problems = validateKnowledgeBase(req);
if (problems.length) {
  console.error('\x1b[31mValidation failed:\x1b[0m');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// Discover document files in a sibling documents/ folder.
const docsDir = join(dirname(resolve(filePath)), 'documents');
let docFiles = [];
try {
  docFiles = (await readdir(docsDir))
    .filter((f) => !f.startsWith('.'))
    .map((f) => join(docsDir, f));
} catch {
  // no documents dir
}

console.log(`Knowledge base "${req.name}" (${req.type}) validated.`);
console.log(`Documents found: ${docFiles.length ? docFiles.map((f) => f.split('/').pop()).join(', ') : '(none)'}`);
if (req.type === 'documents' && docFiles.length === 0) {
  console.warn(
    '\x1b[33mWarning:\x1b[0m documents-type KB has no files in documents/. ' +
      'It will have nothing to ground answers until a document is added.',
  );
}

if (dryRun) {
  console.log('\n--- Dry run: CreateKnowledgeBase payload (not sent) ---');
  console.log(JSON.stringify(req, null, 2));
  if (doPublish) console.log('\nWould publish after upload.');
  process.exit(0);
}

const sdk = await loadSdk();
const client = new sdk.AgenticCXDesignerClient({ apiKey: creds.apiKey, workspaceId: creds.workspaceId });

try {
  const { knowledgeBaseId, status } = await deployKnowledgeBase(client, sdk, req);
  console.log(`  ${req.name}: ${status} (knowledgeBaseId=${knowledgeBaseId ?? 'n/a'})`);
  if (!knowledgeBaseId) fail('No knowledgeBaseId returned; cannot upload documents or publish.');

  for (const f of docFiles) {
    await uploadKnowledgeBaseDocument(client, sdk, { knowledgeBaseId, filePath: f });
  }

  if (doPublish) {
    const pub = await publishKnowledgeBase(client, sdk, {
      knowledgeBaseId,
      version: '1.0',
      description: `Automated publish of ${req.name}`,
    });
    if (pub.status !== 'published') {
      fail(`Publish finished with status "${pub.status}" (expected published).`);
    }
    console.log(`  published (deploymentId=${pub.deploymentId})`);
  }

  console.log(`\x1b[32mDone.\x1b[0m knowledge base ${req.name} (${knowledgeBaseId})`);
  // Emit the id on its own line for scripting.
  console.log(`knowledgeBaseId=${knowledgeBaseId}`);
} catch (e) {
  fail(e?.message ?? String(e));
}
