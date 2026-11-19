import { lightingFor } from './meter.mjs';

export { lightingFor };

// Shows the overall level as a bar across rows 1 and 2, left to right: green, green, yellow, red.
// Row 1 has no key in column 1 or under the knob, so the outer columns are a single key.
export const COLUMNS = [['vu-b0-r2'], ['vu-b1-r1', 'vu-b1-r2'], ['vu-b2-r1', 'vu-b2-r2'], ['vu-b3-r2']];
export const KEYS = COLUMNS.flat();
const STATES = ['g', 'g', 'y', 'r'];
// Level in dBFS at which each column lights. Tune these with `npm run levels`.
export const LEVEL_DB = [-30, -20, -17, -15];

export function offState() {
  return Object.fromEntries(KEYS.map((id) => [id, 'off']));
}

// Turns a level in dBFS into the color of every key: 'off', 'g', 'y' or 'r'.
export function frameFor(db) {
  const lit = LEVEL_DB.filter((threshold) => db > threshold).length;
  return Object.fromEntries(
    COLUMNS.flatMap((keys, column) => keys.map((id) => [id, column < lit ? STATES[column] : 'off'])),
  );
}

// The next request to send: the largest group of changes that share a color,
// or null when the keys already show the frame.
export function nextRequest(frame, shown) {
  const groups = {};
  for (const id of KEYS) if (frame[id] !== shown[id]) (groups[frame[id]] ??= []).push(id);
  const [state, keys] = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  return state ? { state, keys } : null;
}
