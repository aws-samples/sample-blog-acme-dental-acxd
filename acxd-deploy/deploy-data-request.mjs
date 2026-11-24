#!/usr/bin/env node
/**
 * Deploy an exported ACXD data request into a workspace via the ACXD SDK (idempotent).
 *
 * The webhook references secrets by name ({SecretName:NLX.Secret}); those secrets must
 * already exist in the workspace (deploy them first with deploy-secrets.mjs).
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node deploy-data-request.mjs data-requests/acmeLookupAni.json [--dry-run]
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-data-requests.html
 */
import { fail, parseArgs, readJson, loadSdk, requireCreds } from './lib/cli.mjs';
import {
  transformDataRequest,
  validateDataRequest,
  deployDataRequest,
  referencedSecrets,
} from './lib/data-request.mjs';

const { dryRun, positional: filePath } = parseArgs();
if (!filePath) fail('Provide the path to an exported data request JSON file.');

const creds = dryRun ? {} : requireCreds();

const raw = await readJson(filePath);
const req = transformDataRequest(raw);
const problems = validateDataRequest(req);
if (problems.length) {
  console.error('\x1b[31mValidation failed:\x1b[0m');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const secretsUsed = referencedSecrets(raw);
console.log(`Data request "${req.dataRequestId}" validated (type=${req.type}).`);
console.log(`Secrets referenced: ${secretsUsed.length ? secretsUsed.join(', ') : '(none)'}`);
if (secretsUsed.length) {
  console.log('  (these secrets must exist in the workspace before the request can resolve)');
}

if (dryRun) {
  console.log('\n--- Dry run: request payload (not sent) ---');
  console.log(JSON.stringify(req, null, 2));
  process.exit(0);
}

const sdk = await loadSdk();
const client = new sdk.AgenticCXDesignerClient({ apiKey: creds.apiKey, workspaceId: creds.workspaceId });
try {
  const status = await deployDataRequest(client, sdk, req);
  console.log(`\x1b[32mDone.\x1b[0m data request ${req.dataRequestId}: ${status}`);
} catch (e) {
  fail(e?.message ?? String(e));
}
