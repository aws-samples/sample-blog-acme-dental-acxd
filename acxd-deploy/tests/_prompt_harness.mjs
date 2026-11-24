// Test harness: calls promptSecret twice against piped (non-TTY) stdin and prints the
// results as JSON. Used by secret.test.mjs to verify the shared line reader and EOF handling.
import { promptSecret } from '../lib/secret.mjs';

const first = await promptSecret('one: ');
const second = await promptSecret('two: ');
// Print on stderr so the prompt text written to stdout doesn't pollute the JSON line.
process.stderr.write(JSON.stringify({ first, second }) + '\n');
