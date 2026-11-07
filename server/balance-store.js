// Saves admin balance changes (overrides of shared/config.js) to a JSON file and loads them on start.
import fs from 'node:fs';
import { applyBalance, overrides } from '../shared/balance.js';

// Applies the saved overrides, if any. Returns what was applied ({} when there is no file).
export function loadBalance(file) {
  try {
    return applyBalance(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

// Writes the values that differ from the defaults; with none left, the file is removed.
export function saveBalance(file) {
  const changed = overrides();
  if (Object.keys(changed).length) fs.writeFileSync(file, `${JSON.stringify(changed, null, 2)}\n`);
  else fs.rmSync(file, { force: true });
  return changed;
}
