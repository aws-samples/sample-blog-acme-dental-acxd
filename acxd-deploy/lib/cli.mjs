/**
 * Shared CLI helpers for the standalone single-resource deploy scripts.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function fail(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

export function parseArgs() {
  const args = process.argv.slice(2);
  return {
    args,
    dryRun: args.includes('--dry-run'),
    positional: args.find((a) => !a.startsWith('--')),
    flag(name, fallback) {
      const i = args.indexOf(name);
      return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
    },
  };
}

export async function readJson(path) {
  const abs = resolve(path);
  const raw = await readFile(abs, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse JSON in ${abs}: ${e.message}`);
  }
}

/** Lazy-load the SDK so --dry-run works without it installed. */
export async function loadSdk() {
  try {
    return await import('amazon-connect-acxd-sdk');
  } catch (e) {
    fail(
      'Could not load "amazon-connect-acxd-sdk". Run "npm install" first, or use --dry-run. ' +
        `(${e.message})`,
    );
  }
}

export function requireCreds({ needWorkspace = true } = {}) {
  const apiKey = process.env.ACXD_API_KEY;
  const workspaceId = process.env.ACXD_WORKSPACE_ID;
  if (!apiKey) fail('ACXD_API_KEY is not set. Export it or run with --dry-run.');
  if (needWorkspace && !workspaceId) {
    fail('ACXD_WORKSPACE_ID is not set. Export it or run with --dry-run.');
  }
  return { apiKey, workspaceId };
}
