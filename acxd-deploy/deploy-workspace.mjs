#!/usr/bin/env node
/**
 * Create (or ensure) an Agentic CX Designer (ACXD) workspace via the ACXD SDK, and print its
 * workspace ID for use with deploy-all.mjs.
 *
 * Workspace operations are ACCOUNT-LEVEL: the SDK client is constructed WITHOUT a workspaceId,
 * and the API key must belong to a programmatic user with an account-level role
 * (roleConfig.accountRole = "administrator"). A workspace-scoped key will fail here even
 * though the request shape is correct.
 *
 * Idempotent: if a workspace with the same name already exists, it is updated (tags) rather
 * than duplicated. Matching is by name, since workspaceId is server-assigned.
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... node deploy-workspace.mjs --name "My Workspace" [--tags a,b,c]
 *
 * Flags:
 *   --name <name>     Workspace name (required). Alphanumeric + spaces/punctuation, 1-36 chars.
 *   --tags <list>     Comma-separated tags (optional, max 5).
 *   --dry-run         Validate + print the request, without calling the API.
 *
 * Note: ACXD_WORKSPACE_ID is intentionally NOT used here (account-level operation).
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-workspaces.html
 */

const API_KEY = process.env.ACXD_API_KEY;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

const NAME = flagValue('--name');
const TAGS = flagValue('--tags')
  ? flagValue('--tags').split(',').map((t) => t.trim()).filter(Boolean)
  : [];

function fail(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

if (!NAME) {
  fail('Provide --name "<workspace name>". See usage in the file header.');
}
if (!DRY_RUN && !API_KEY) {
  fail('ACXD_API_KEY is not set. Export it or run with --dry-run.');
}

// ---------------------------------------------------------------------------
// Validate against documented constraints.
// ---------------------------------------------------------------------------
function validate(name, tags) {
  const problems = [];
  if (name.length < 1 || name.length > 36) {
    problems.push('name must be 1-36 characters.');
  }
  // Catch smart/curly quotes in the name — a common copy-paste mistake where the shell does
  // not treat them as quoting, so only a fragment of a multi-word name reaches the script.
  if (/[\u2018\u2019\u201C\u201D]/.test(name)) {
    problems.push(
      `name contains a smart/curly quote (got "${name}"). This usually means the shell split a ` +
        'multi-word name. Re-run using straight quotes, e.g. --name "Acme Insurance WS".',
    );
  }
  if (tags.length > 5) {
    problems.push(`tags may have at most 5 entries (got ${tags.length}).`);
  }
  for (const t of tags) {
    if (typeof t !== 'string') problems.push(`tag "${t}" must be a string.`);
  }
  return problems;
}

async function main() {
  const request = { name: NAME };
  if (TAGS.length) request.tags = TAGS;

  const problems = validate(NAME, TAGS);
  if (problems.length) {
    console.error('\x1b[31mValidation failed:\x1b[0m');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`Workspace "${NAME}" validated${TAGS.length ? ` (tags: ${TAGS.join(', ')})` : ''}.`);

  if (DRY_RUN) {
    console.log('\n--- Dry run: request payload (not sent) ---');
    console.log(JSON.stringify(request, null, 2));
    console.log('\nNote: account-level operation; the client would be built WITHOUT a workspaceId.');
    return;
  }

  let sdk;
  try {
    sdk = await import('amazon-connect-acxd-sdk');
  } catch (e) {
    fail(
      'Could not load "amazon-connect-acxd-sdk". Run "npm install" first, or use --dry-run. ' +
        `(${e.message})`,
    );
  }

  // Account-level: NO workspaceId on the client.
  const client = new sdk.AgenticCXDesignerClient({ apiKey: API_KEY });

  // Find an existing workspace with the same name (paginated).
  let existingId = null;
  try {
    let nextToken;
    do {
      const page = await client.send(new sdk.ListWorkspacesCommand({ nextToken }));
      const hit = (page.items ?? []).find((w) => w.name === NAME);
      if (hit) {
        existingId = hit.workspaceId;
        break;
      }
      nextToken = page.nextToken ?? undefined;
    } while (nextToken);
  } catch (e) {
    fail(`ListWorkspaces failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }

  try {
    if (existingId) {
      console.log(`Workspace "${NAME}": updating (already exists, ${existingId})`);
      const res = await client.send(
        new sdk.UpdateWorkspaceCommand({ workspaceId: existingId, name: NAME, ...(TAGS.length ? { tags: TAGS } : {}) }),
      );
      printResult(res?.workspaceId ?? existingId, 'updated');
    } else {
      console.log(`Workspace "${NAME}": creating (new)`);
      const res = await client.send(new sdk.CreateWorkspaceCommand(request));
      printResult(res?.workspaceId, 'created');
    }
  } catch (e) {
    // A create race can 409 -> fall back to update by re-listing.
    if ((e?.name === 'ConflictException' || e?.$metadata?.httpStatusCode === 409) && !existingId) {
      console.log(`Workspace "${NAME}": updating (created concurrently, retried as update)`);
      const page = await client.send(new sdk.ListWorkspacesCommand({}));
      const hit = (page.items ?? []).find((w) => w.name === NAME);
      if (!hit) fail('Conflict on create but workspace not found on re-list.');
      const res = await client.send(
        new sdk.UpdateWorkspaceCommand({ workspaceId: hit.workspaceId, name: NAME, ...(TAGS.length ? { tags: TAGS } : {}) }),
      );
      printResult(res?.workspaceId ?? hit.workspaceId, 'updated after conflict');
    } else {
      fail(`Workspace deploy failed: ${e?.name ?? ''} ${e?.message ?? e}`);
    }
  }
}

function printResult(workspaceId, status) {
  console.log(`\x1b[32mDone.\x1b[0m Workspace ${status}.`);
  console.log(`\n  workspaceId: ${workspaceId ?? 'n/a'}`);
  if (workspaceId) {
    console.log('\nUse it with the other scripts:');
    console.log(`  export ACXD_WORKSPACE_ID='${workspaceId}'`);
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
