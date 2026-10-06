import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const patch = 'patches/@opencode+ai+2.0.24.patch';
const installed = JSON.parse(
  await readFile(
    new URL('../node_modules/@opencode/ai/package.json', import.meta.url),
    'utf8',
  ),
);
if (installed.version !== '2.0.24') {
  throw new Error(
    'Review the declaration patch before changing the OpenCode SDK version.',
  );
}
const git = (...args) =>
  spawnSync('git', ['apply', ...args, patch], { cwd: root, encoding: 'utf8' });
const checked = git('--check');
if (checked.status === 0) {
  const applied = git();
  if (applied.status !== 0)
    throw new Error(
      `Cannot apply the SDK declaration patch: ${applied.stderr}`,
    );
} else if (git('--reverse', '--check').status !== 0) {
  throw new Error(
    `The SDK declarations do not match the tracked patch: ${checked.stderr}`,
  );
}
