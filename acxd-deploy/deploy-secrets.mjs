#!/usr/bin/env node
/**
 * Deploy ACXD secrets from a non-sensitive manifest, prompting for each VALUE interactively.
 *
 * The manifest (secrets/secrets.json) lists only names/descriptions/isSensitive — never
 * values. Values are typed at runtime with input hidden, held in memory, and sent straight
 * to CreateSecret/UpdateSecret. Nothing sensitive is written to disk or logged.
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node deploy-secrets.mjs [secrets/secrets.json] [--dry-run]
 *
 * --dry-run lists the secret names it would prompt for, and prompts for nothing.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-secrets.html
 */
import { fail, parseArgs, readJson, loadSdk, requireCreds } from './lib/cli.mjs';
import { promptSecret, validateSecretName, deploySecret } from './lib/secret.mjs';

const { dryRun, positional } = parseArgs();
const manifestPath = positional ?? 'secrets/secrets.json';

const manifest = await readJson(manifestPath);
const secrets = manifest?.secrets;
if (!Array.isArray(secrets) || secrets.length === 0) {
  fail(`Manifest ${manifestPath} must contain a non-empty "secrets" array.`);
}

const problems = [];
for (const s of secrets) {
  if (!s.name || !validateSecretName(s.name)) {
    problems.push(`secret name "${s.name}" must be alphanumeric + underscores, 3-100 chars.`);
  }
  if (s.description != null && s.description.length > 200) {
    problems.push(`description for "${s.name}" exceeds 200 chars.`);
  }
  if ('secretValue' in s || 'value' in s) {
    problems.push(`secret "${s.name}" must NOT contain a value in the manifest; values are prompted.`);
  }
}
if (problems.length) {
  console.error('\x1b[31mValidation failed:\x1b[0m');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`Secrets manifest validated: ${secrets.map((s) => s.name).join(', ')}`);

if (dryRun) {
  console.log('\nDry run: would prompt interactively for each value above. Nothing sent.');
  process.exit(0);
}

const creds = requireCreds();
const sdk = await loadSdk();
const client = new sdk.AgenticCXDesignerClient({ apiKey: creds.apiKey, workspaceId: creds.workspaceId });

console.log('\nEnter a value for each secret (input hidden). Leave blank to skip a secret.\n');
for (const s of secrets) {
  const value = await promptSecret(`  ${s.name}: `);
  if (!value) {
    console.log(`  skipped "${s.name}" (no value entered)`);
    continue;
  }
  try {
    const status = await deploySecret(client, sdk, {
      name: s.name,
      secretValue: value,
      description: s.description,
      isSensitive: s.isSensitive,
    });
    console.log(`  ${s.name}: ${status}`);
  } catch (e) {
    fail(e?.message ?? String(e));
  }
}

console.log('\x1b[32mDone.\x1b[0m secrets deployed.');
