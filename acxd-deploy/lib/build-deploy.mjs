/**
 * Application build + deployment logic shared by deploy-all.mjs.
 *
 * SDK references:
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-application-builds.html
 *   https://docs.aws.amazon.com/connect/latest/devguide/acxd-application-deployments.html
 *
 * Both operations are asynchronous:
 *   - Build:      PENDING -> BUILT | FAILED
 *   - Deployment: pending -> deployed
 * so each create is followed by polling the corresponding Get until it settles.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a build and poll until it settles.
 * Returns { buildId, status } where status is "BUILT" or "FAILED".
 * Throws on timeout or API error.
 */
export async function buildApplication(
  client,
  commands,
  { applicationId, version, description, languageSettings },
  { pollIntervalMs = 5000, timeoutMs = 300000, log = console.log } = {},
) {
  const { CreateApplicationBuildCommand, GetApplicationBuildCommand } = commands;

  const input = { applicationIdentifier: applicationId };
  if (version != null) input.version = version;
  if (description != null) input.description = description;
  if (languageSettings != null) input.languageSettings = languageSettings;

  const created = await client.send(new CreateApplicationBuildCommand(input));
  const buildId = created?.buildId;
  if (!buildId) throw new Error('CreateApplicationBuild did not return a buildId.');
  log(`  build ${buildId} started (status=${created?.status ?? 'PENDING'})`);

  const deadline = Date.now() + timeoutMs;
  // Statuses per docs: PENDING (in progress), BUILT (success), FAILED (error).
  let status = created?.status ?? 'PENDING';
  while (status === 'PENDING') {
    if (Date.now() > deadline) {
      throw new Error(`Build ${buildId} did not finish within ${timeoutMs / 1000}s (last status ${status}).`);
    }
    await sleep(pollIntervalMs);
    const res = await client.send(
      new GetApplicationBuildCommand({ applicationIdentifier: applicationId, buildIdentifier: buildId }),
    );
    status = res?.status ?? status;
    log(`  build ${buildId} status=${status}`);
  }

  return { buildId, status };
}

/**
 * Create a deployment of a built build to an environment, and poll until it settles.
 * Returns { deploymentId, status } where status is the final deploymentStatus.
 * Throws on timeout or API error.
 */
export async function deployBuild(
  client,
  commands,
  { applicationId, buildId, environment, languageCodes, description },
  { pollIntervalMs = 5000, timeoutMs = 300000, log = console.log } = {},
) {
  const { CreateApplicationDeploymentCommand, GetApplicationDeploymentCommand } = commands;

  const input = {
    applicationIdentifier: applicationId,
    buildIdentifier: buildId,
    environment,
  };
  if (languageCodes != null) input.languageCodes = languageCodes;
  if (description != null) input.description = description;

  const created = await client.send(new CreateApplicationDeploymentCommand(input));
  const deploymentId = created?.deploymentId;
  if (!deploymentId) throw new Error('CreateApplicationDeployment did not return a deploymentId.');
  log(`  deployment ${deploymentId} started to "${environment}" (status=${created?.deploymentStatus ?? 'pending'})`);

  const deadline = Date.now() + timeoutMs;
  // The docs enumerate deploymentStatus only as "e.g., pending, deployed" (non-exhaustive);
  // live runs also report "scheduled" as an in-progress state. So keep polling while the
  // status is any known in-progress value, treat a "deployed" status as success, and treat
  // anything containing "fail" as terminal failure.
  const IN_PROGRESS = new Set(['pending', 'scheduled', 'in_progress', 'inprogress', 'deploying']);
  let status = created?.deploymentStatus ?? 'pending';
  while (IN_PROGRESS.has(String(status).toLowerCase())) {
    if (Date.now() > deadline) {
      throw new Error(
        `Deployment ${deploymentId} did not finish within ${timeoutMs / 1000}s (last status ${status}).`,
      );
    }
    await sleep(pollIntervalMs);
    const res = await client.send(
      new GetApplicationDeploymentCommand({
        applicationIdentifier: applicationId,
        deploymentIdentifier: deploymentId,
      }),
    );
    status = res?.deploymentStatus ?? status;
    log(`  deployment ${deploymentId} status=${status}`);
  }

  return { deploymentId, status };
}
