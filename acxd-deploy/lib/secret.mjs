/**
 * Secret deploy logic + interactive value prompting.
 *
 * SDK reference: https://docs.aws.amazon.com/connect/latest/devguide/acxd-secrets.html
 *
 * SECURITY: secret values are never read from the manifest file, never logged, and never
 * echoed to the terminal. They are prompted for at runtime with input hidden, held only in
 * memory, and sent straight to CreateSecret/UpdateSecret. GetSecret returns masked values,
 * so idempotency uses ListSecrets (names only) to decide create vs update.
 */
import { createInterface } from 'node:readline';

/**
 * Shared line reader for the non-TTY (piped/CI) path.
 *
 * One readline interface is created per process and drives all promptSecret calls, so no
 * stdin bytes are dropped between prompts: piping "url\nkey\n" feeds the first and second
 * prompt in order. On EOF (fewer lines piped than prompts, or none), waiting callers resolve
 * with '' - which the deploy loop treats as "skip" - instead of hanging forever.
 */
let lineReader = null;
function getLineReader() {
  if (lineReader) return lineReader;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const queue = []; // lines read but not yet requested
  const waiters = []; // resolvers waiting for the next line
  let ended = false;
  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiters.length) waiters.shift()('');
  });
  lineReader = {
    next() {
      return new Promise((res) => {
        if (queue.length) return res(queue.shift());
        if (ended) return res('');
        waiters.push(res);
      });
    },
  };
  return lineReader;
}

/**
 * Prompt for a single secret value with the typed characters hidden.
 *
 * Reads raw keypresses from stdin rather than filtering stdout. The previous approach
 * (suppressing writes that didn't contain the prompt text) leaked the value whenever the
 * terminal redrew the prompt and typed text together - e.g. on backspace or arrow keys.
 * Here nothing the user types is ever echoed, so there is no redraw to leak.
 */
export function promptSecret(promptText) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    // Fall back to a plain (visible) line read if stdin isn't an interactive TTY (piped/CI).
    // A shared line reader buffers across prompts and resolves '' on EOF (never hangs).
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      output.write(promptText);
      getLineReader().next().then(resolve, reject);
      return;
    }

    output.write(promptText);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let value = '';
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };
    const onData = (ch) => {
      switch (ch) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          output.write('\n');
          cleanup();
          resolve(value);
          return;
        case '\u0003': // Ctrl-C
          output.write('\n');
          cleanup();
          reject(new Error('Prompt cancelled'));
          return;
        case '\u007f': // Backspace - mutate buffer only, never redraw the value
        case '\b':
          if (value.length > 0) value = value.slice(0, -1);
          return;
        default:
          // Ignore other control/escape sequences (arrow keys etc.); append printable chars.
          if (ch >= ' ') value += ch;
          return;
      }
    };
    input.on('data', onData);
  });
}

export function validateSecretName(name) {
  // Alphanumeric + underscores, 3-100 chars.
  return /^[A-Za-z0-9_]{3,100}$/.test(name);
}

/** Return the set of secret names that already exist in the workspace (paginated). */
export async function listExistingSecretNames(client, commands) {
  const { ListSecretsCommand } = commands;
  const names = new Set();
  let nextToken;
  do {
    const page = await client.send(new ListSecretsCommand({ nextToken }));
    for (const s of page.items ?? []) names.add(s.name);
    nextToken = page.nextToken ?? undefined;
  } while (nextToken);
  return names;
}

/**
 * Deploy one secret (create-or-update, idempotent by name via ListSecrets).
 * `secretValue` is the sensitive value (already collected). Returns status string.
 */
export async function deploySecret(client, commands, { name, secretValue, description, isSensitive }, log = console.log) {
  const { CreateSecretCommand, UpdateSecretCommand } = commands;

  // Idempotency: decide create vs update by name. Reuse the shared paginated lister
  // rather than re-walking ListSecrets here, so both paths stay in sync.
  const exists = (await listExistingSecretNames(client, commands)).has(name);

  try {
    if (exists) {
      log(`  secret "${name}" exists -> UpdateSecret`);
      await client.send(
        new UpdateSecretCommand({
          secretIdentifier: name,
          secretValue,
          ...(description != null ? { description } : {}),
          ...(isSensitive != null ? { isSensitive } : {}),
        }),
      );
      return 'updated';
    }
    log(`  secret "${name}" not found -> CreateSecret`);
    await client.send(
      new CreateSecretCommand({
        name,
        secretValue,
        ...(description != null ? { description } : {}),
        ...(isSensitive != null ? { isSensitive } : {}),
      }),
    );
    return 'created';
  } catch (e) {
    if ((e?.name === 'ConflictException' || e?.$metadata?.httpStatusCode === 409) && !exists) {
      log(`  secret "${name}" Conflict -> retry UpdateSecret`);
      await client.send(
        new UpdateSecretCommand({
          secretIdentifier: name,
          secretValue,
          ...(description != null ? { description } : {}),
          ...(isSensitive != null ? { isSensitive } : {}),
        }),
      );
      return 'updated after conflict';
    }
    // Never include secretValue in error text.
    throw new Error(`Deploy secret "${name}" failed: ${e?.name ?? ''} ${e?.message ?? e}`);
  }
}
