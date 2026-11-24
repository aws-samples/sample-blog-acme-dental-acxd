#!/usr/bin/env node
/**
 * Deploy an exported ACXD context variable into a workspace via the ACXD SDK (idempotent).
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node deploy-context-variable.mjs context-variables/acmeIsAuthenticated.json [--dry-run]
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-context-variables.html
 */
import { fail, parseArgs, readJson, loadSdk, requireCreds } from './lib/cli.mjs';
import {
  transformContextVariable,
  validateContextVariable,
  deployContextVariable,
} from './lib/context-variable.mjs';

const { dryRun, positional: filePath } = parseArgs();
if (!filePath) fail('Provide the path to an exported context variable JSON file.');

const creds = dryRun ? {} : requireCreds();

const req = transformContextVariable(await readJson(filePath));
const problems = validateContextVariable(req);
if (problems.length) {
  console.error('\x1b[31mValidation failed:\x1b[0m');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Context variable "${req.name}" validated.`);

if (dryRun) {
  console.log('\n--- Dry run: request payload (not sent) ---');
  console.log(JSON.stringify(req, null, 2));
  process.exit(0);
}

const sdk = await loadSdk();
const client = new sdk.AgenticCXDesignerClient({ apiKey: creds.apiKey, workspaceId: creds.workspaceId });
try {
  const status = await deployContextVariable(client, sdk, req);
  console.log(`\x1b[32mDone.\x1b[0m context variable ${req.name}: ${status}`);
} catch (e) {
  fail(e?.message ?? String(e));
}
