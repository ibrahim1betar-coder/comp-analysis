/** Run a bundled Python script and parse its JSON output. Finds python3 / python / py automatically. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ApiError } from './http.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const scriptPath = (name) => join(root, 'scripts', name);

const CANDIDATES = process.env.PYTHON_BIN ? [process.env.PYTHON_BIN] : process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
let resolved = null;

function tryRun(bin, args, { timeoutMs }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ spawnError: e });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ spawnError: e }); });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}

/** Which Python launcher works on this machine (cached). */
export async function findPython() {
  if (resolved) return resolved;
  for (const bin of CANDIDATES) {
    const r = await tryRun(bin, ['-c', 'import sys; print(sys.version_info[0])'], { timeoutMs: 10000 });
    if (!r.spawnError && r.code === 0 && r.out.trim() === '3') return (resolved = bin);
  }
  throw new ApiError('Python 3 was not found. Install it from https://www.python.org/downloads/ (tick "Add Python to PATH"), then restart the dashboard.');
}

export async function runPythonJson(script, args, { timeoutMs = 240_000 } = {}) {
  const bin = await findPython();
  const r = await tryRun(bin, [script, ...args], { timeoutMs });
  if (r.spawnError) throw new ApiError(`Could not start Python: ${r.spawnError.message}`);
  if (r.signal) throw new ApiError(`Python script timed out after ${Math.round(timeoutMs / 1000)} s`);
  let data = null;
  try { data = JSON.parse(r.out.trim().split('\n').pop() || 'null'); } catch { data = null; }
  if (data?.error) throw new ApiError(data.error, { status: r.code === 2 ? 400 : 500 });
  if (r.code !== 0 || !data) throw new ApiError(`Python script failed (exit ${r.code}): ${(r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
  return data;
}
