import { spawn } from 'node:child_process';

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function validModelRow(modelId, name) {
  return typeof modelId === 'string' && MODEL_ID_RE.test(modelId) &&
    typeof name === 'string' && name.trim().length > 0 && name.length <= 512 &&
    !/[\r\n\0]/.test(name)
    ? { modelId, name: name.trim() }
    : null;
}

function parseModelOutput(output) {
  const models = [];
  const seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('\t');
    if (separator < 1) continue;
    const model = validModelRow(line.slice(0, separator).trim(), line.slice(separator + 1));
    if (!model || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    models.push(model);
  }
  return models;
}

export function listModels({ command = 'agy', cwd = process.cwd(), prefixArgs = [],
  spawnFn = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError('timeoutMs must be between 1 and 10000');
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) {
    throw new TypeError('maxOutputBytes must be a bounded positive integer');
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, [...prefixArgs, 'models'], {
        shell: false,
        cwd,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      resolve([]);
      return;
    }
    let output = '';
    let bytes = 0;
    let settled = false;
    let timer;
    const finish = (models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(models);
    };
    const stop = () => {
      try { child.kill?.(); } catch {}
    };
    timer = setTimeout(() => { stop(); finish([]); }, timeoutMs);
    const stdout = child?.stdout;
    try { stdout?.setEncoding?.('utf8'); } catch {}
    stdout?.on?.('data', (chunk) => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      bytes += Buffer.byteLength(text);
      if (bytes > maxOutputBytes) {
        stop();
        finish([]);
        return;
      }
      output += text;
    });
    stdout?.on?.('error', () => { stop(); finish([]); });
    child?.on?.('error', () => finish([]));
    child?.on?.('close', (code) => finish(code === 0 ? parseModelOutput(output) : []));
  });
}

export function modelConfigOptions(models, currentModel) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const options = [];
  const seen = new Set();
  for (const candidate of models) {
    const model = validModelRow(candidate?.modelId, candidate?.name);
    if (!model || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    options.push({ value: model.modelId, name: model.name, displayName: model.name });
  }
  if (options.length === 0) return [];
  return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: currentModel,
    configId: 'model', displayName: 'Model', options }];
}
