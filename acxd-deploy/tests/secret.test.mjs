import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSecretName } from '../lib/secret.mjs';

test('validateSecretName accepts alphanumeric + underscore, 3-100 chars', () => {
  assert.equal(validateSecretName('API_Key'), true);
  assert.equal(validateSecretName('API_URL_Base'), true);
  assert.equal(validateSecretName('abc'), true);
});

test('validateSecretName rejects too-short, bad chars, and too-long names', () => {
  assert.equal(validateSecretName('ab'), false);
  assert.equal(validateSecretName('has space'), false);
  assert.equal(validateSecretName('has-dash'), false);
  assert.equal(validateSecretName('x'.repeat(101)), false);
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const harness = join(dirname(fileURLToPath(import.meta.url)), '_prompt_harness.mjs');

function runHarness(stdin) {
  const r = spawnSync(process.execPath, [harness], { input: stdin, encoding: 'utf8' });
  // Harness prints the JSON result on stderr (stdout carries the prompt text).
  const line = r.stderr.trim().split('\n').pop();
  return JSON.parse(line);
}

test('promptSecret (piped): two lines feed two prompts in order', () => {
  const { first, second } = runHarness('url-value\nkey-value\n');
  assert.equal(first, 'url-value');
  assert.equal(second, 'key-value');
});

test('promptSecret (piped): missing second line resolves to empty string, no hang', () => {
  const { first, second } = runHarness('only-one\n');
  assert.equal(first, 'only-one');
  assert.equal(second, '');
});

test('promptSecret (piped): empty stdin resolves both prompts to empty string', () => {
  const { first, second } = runHarness('');
  assert.equal(first, '');
  assert.equal(second, '');
});
