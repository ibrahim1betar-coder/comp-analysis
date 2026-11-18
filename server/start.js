// Launcher: checks the Node.js version, picks the right flags and prints a clear fix when something is missing.
// Usage: node server/start.js [index|seed|cli-sync] [args...]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [major, minor] = process.versions.node.split('.').map(Number);
const fail = (lines) => { console.error('\n' + lines.join('\n') + '\n'); process.exit(1); };

// node:sqlite ships in Node 22.5+ (behind a flag until 22.13) and in every 23.4+/24+ release.
const sqliteBuiltIn = major > 22 || (major === 22 && minor >= 5);
const needsFlag = major === 22 && minor < 13 || (major === 23 && minor < 4);
if (!sqliteBuiltIn) {
  fail([
    `Lime Competitor Analysis needs Node.js 22.13 or newer. You are running Node ${process.versions.node}.`,
    'Install the current LTS from https://nodejs.org (or run: nvm install 22 && nvm use 22), then try again.',
  ]);
}
if (!existsSync(join(root, 'node_modules', 'fastify'))) {
  fail(['Dependencies are not installed yet. Run this first, inside the project folder:', '  npm install']);
}

const script = { index: 'server/index.js', seed: 'server/seed.js', 'cli-sync': 'server/cli-sync.js' }[process.argv[2] || 'index'] || 'server/index.js';
const args = process.argv.slice(3);
const flags = needsFlag ? ['--experimental-sqlite', '--no-warnings'] : ['--no-warnings=ExperimentalWarning'];
if (process.env.WATCH) flags.push('--watch');

const child = spawn(process.execPath, [...flags, join(root, script), ...args], { stdio: 'inherit', cwd: process.cwd() });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
