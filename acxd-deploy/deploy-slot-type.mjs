#!/usr/bin/env node
/**
 * Deploy an exported ACXD slot type into a workspace via the ACXD SDK (idempotent).
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node deploy-slot-type.mjs slot-types/acmeMemberId.json [--dry-run]
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-slot-types.html
 */
import { fail, parseArgs, readJson, loadSdk, requireCreds } from './lib/cli.mjs';
import { transformSlotType, validateSlotType, deploySlotType } from './lib/slot-type.mjs';

const { dryRun, positional: filePath } = parseArgs();
if (!filePath) fail('Provide the path to an exported slot type JSON file.');

const creds = dryRun ? {} : requireCreds();

const req = transformSlotType(await readJson(filePath));
const problems = validateSlotType(req);
if (problems.length) {
  console.error('\x1b[31mValidation failed:\x1b[0m');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Slot type "${req.slotTypeId}" validated: ${req.values.length} value(s).`);

if (dryRun) {
  console.log('\n--- Dry run: request payload (not sent) ---');
  console.log(JSON.stringify(req, null, 2));
  process.exit(0);
}

const sdk = await loadSdk();
const client = new sdk.AgenticCXDesignerClient({ apiKey: creds.apiKey, workspaceId: creds.workspaceId });
try {
  const status = await deploySlotType(client, sdk, req);
  console.log(`\x1b[32mDone.\x1b[0m slot type ${req.slotTypeId}: ${status}`);
} catch (e) {
  fail(e?.message ?? String(e));
}
