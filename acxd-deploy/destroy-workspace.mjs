#!/usr/bin/env node
/**
 * Delete an ACXD workspace via the ACXD SDK.
 *
 * DeleteWorkspace deletes the workspace AND ALL ITS RESOURCES (applications, flows, knowledge
 * bases, secrets, everything). This is an ACCOUNT-LEVEL operation, so the client is built
 * WITHOUT a workspaceId, and the API key must belong to a programmatic user with an
 * account-level administrator role.
 *
 * SAFETY:
 *   - This is HIGHLY DESTRUCTIVE and cascades to every resource in the workspace.
 *   - By default it only PREVIEWS. Nothing is deleted unless you pass --confirm.
 *   - You must identify the workspace explicitly by --name OR --workspace-id. To reduce the
 *     chance of deleting the wrong one, if you pass --name the script shows the resolved ID
 *     and requires that a matching workspace is found before deleting.
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... node destroy-workspace.mjs --name "Acme Insurance WS" --confirm
 *   ACXD_API_KEY=acxd_live_... node destroy-workspace.mjs --workspace-id <uuid> --confirm
 *
 * Flags:
 *   --name <name>          Workspace name to delete (resolved to an ID via ListWorkspaces).
 *   --workspace-id <uuid>  Workspace ID to delete (use instead of --name).
 *   --confirm              Actually perform the deletion (without this, it's a preview).
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-workspaces.html
 */

const API_KEY = process.env.ACXD_API_KEY;

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');

function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}
const NAME = flagValue('--name');
const WORKSPACE_ID_ARG = flagValue('--workspace-id');

function fail(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

if (!API_KEY) fail('ACXD_API_KEY is not set.');
if (!NAME && !WORKSPACE_ID_ARG) {
  fail('Identify the workspace with --name "<name>" or --workspace-id <uuid>.');
}
if (NAME && WORKSPACE_ID_ARG) {
  fail('Pass only one of --name or --workspace-id, not both.');
}

async function main() {
  let sdk;
  try {
    sdk = await import('amazon-connect-acxd-sdk');
  } catch (e) {
    fail(`Could not load "amazon-connect-acxd-sdk". Run "npm install" first. (${e.message})`);
  }

  // Account-level: NO workspaceId on the client.
  const client = new sdk.AgenticCXDesignerClient({ apiKey: API_KEY });

  // Resolve the target workspace and confirm it exists.
  let targetId = WORKSPACE_ID_ARG ?? null;
  let targetName = null;
  try {
    if (NAME) {
      let nextToken;
      do {
        const page = await client.send(new sdk.ListWorkspacesCommand({ nextToken }));
        const hit = (page.items ?? []).find((w) => w.name === NAME);
        if (hit) {
          targetId = hit.workspaceId;
          targetName = hit.name;
          break;
        }
        nextToken = page.nextToken ?? undefined;
      } while (nextToken);
      if (!targetId) fail(`No workspace named "${NAME}" found. Nothing to delete.`);
    } else {
      // Verify the given ID exists (and get its name for the confirmation output).
      try {
        const ws = await client.send(new sdk.GetWorkspaceCommand({ workspaceId: targetId }));
        targetName = ws?.name ?? null;
      } catch (e) {
        if (e?.name === 'ResourceNotFoundException' || e?.$metadata?.httpStatusCode === 404) {
          fail(`Workspace ${targetId} not found. Nothing to delete.`);
        }
        throw e;
      }
    }
  } catch (e) {
    fail(`Resolving workspace failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }

  // ---- Report ----
  console.log('=== Workspace deletion plan ===');
  console.log(`Workspace: ${targetName ?? '(name unknown)'}  (${targetId})`);
  console.log('\x1b[31mWARNING:\x1b[0m DeleteWorkspace removes the workspace AND ALL its resources');
  console.log('  (applications, flows, knowledge bases, secrets, deployments — everything). This cannot be undone.');

  if (!CONFIRM) {
    console.log(
      '\n\x1b[33mPreview only.\x1b[0m Nothing deleted. Re-run with --confirm to delete this workspace.',
    );
    return;
  }

  try {
    await client.send(new sdk.DeleteWorkspaceCommand({ workspaceId: targetId }));
    console.log(`\n\x1b[32mDone.\x1b[0m Deleted workspace ${targetName ?? ''} (${targetId}).`);
  } catch (e) {
    fail(`DeleteWorkspace failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
