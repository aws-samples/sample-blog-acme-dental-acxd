#!/usr/bin/env node
/**
 * Read-only check of an application deployment's current status, and optionally wait for it
 * to settle. Useful after a deploy run where the poll gave up early on a transient status.
 *
 * Usage:
 *   ACXD_API_KEY=acxd_live_... ACXD_WORKSPACE_ID=<uuid> \
 *     node check-deployment.mjs --app-id <applicationId> [--deployment-id <id>] [--wait]
 *
 * With no --deployment-id, lists all deployments for the application.
 * With --wait, polls until the deployment reaches a terminal (non in-progress) status.
 */
import { fail, parseArgs, loadSdk, requireCreds } from './lib/cli.mjs';

const { args, flag } = parseArgs();
const appId = flag('--app-id', null);
const deploymentId = flag('--deployment-id', null);
const wait = args.includes('--wait');

if (!appId) fail('Provide --app-id <applicationId>.');
const creds = requireCreds();
const sdk = await loadSdk();
const client = new sdk.AgenticCXDesignerClient({ apiKey: creds.apiKey, workspaceId: creds.workspaceId });

const IN_PROGRESS = new Set(['pending', 'scheduled', 'in_progress', 'inprogress', 'deploying']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (!deploymentId) {
    const page = await client.send(
      new sdk.ListApplicationDeploymentsCommand({ applicationIdentifier: appId }),
    );
    const items = page.items ?? [];
    if (!items.length) {
      console.log('No deployments found for this application.');
    } else {
      console.log(`Deployments for ${appId}:`);
      for (const d of items) {
        console.log(`  ${d.deploymentId}  env=${d.environment}  status=${d.deploymentStatus}  build=${d.buildId}`);
      }
    }
    process.exit(0);
  }

  let status;
  do {
    const res = await client.send(
      new sdk.GetApplicationDeploymentCommand({
        applicationIdentifier: appId,
        deploymentIdentifier: deploymentId,
      }),
    );
    status = res?.deploymentStatus;
    console.log(`deployment ${deploymentId}: status=${status} env=${res?.environment} build=${res?.buildId}`);
    if (!wait || !IN_PROGRESS.has(String(status).toLowerCase())) break;
    await sleep(5000);
  } while (true);

  if (String(status).toLowerCase() === 'deployed') {
    console.log('\x1b[32mDeployment is live (deployed).\x1b[0m');
  } else if (IN_PROGRESS.has(String(status).toLowerCase())) {
    console.log('Still in progress. Re-run with --wait to poll until it settles.');
  } else {
    console.log(`Terminal status: ${status}`);
  }
} catch (e) {
  fail(`${e?.name ?? ''} ${e?.message ?? e}`);
}
