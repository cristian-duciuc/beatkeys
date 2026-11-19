// Columns 2 to 4 of the Creator Micro V2 are three bands: low, mid and high.
// Rows count from the top (1) to the bottom (4). Bands 1 and 2 have a key on every row.
// Band 3 sits under the knob, so it only has rows 2 to 4.
export const ROWS = { 1: [4, 3, 2, 1], 2: [4, 3, 2, 1], 3: [4, 3, 2] };
export const ALL_KEYS = 'vu-b[0-3]-r[1-4]'; // b0 is column 1, only on the volume layer
export const COLORS = { g: 0x00ff00, y: 0xffaa00, r: 0xff0000 };
// The Codex Micro rejects effect 0, so a key turns off as a black solid color.
export const OFF = { color: 0, brightness: 0, effect: 1 };

const key = (band, row) => `vu-b${band}-r${row}`;
export const KEYS = Object.entries(ROWS).flatMap(([band, rows]) => rows.map((row) => key(band, row)));

export function offState() {
  return Object.fromEntries(KEYS.map((id) => [id, 'off']));
}

// Turns the lit steps of each band (0 to 4) into the color of every key: 'off', 'g', 'y' or 'r'.
// Steps light from the bottom: green, green, yellow, red.
export function frameFor(steps) {
  const frame = offState();
  steps.forEach((n, index) => {
    const band = index + 1;
    if (n >= 1) frame[key(band, 4)] = 'g';
    if (n >= 2) frame[key(band, 3)] = 'g';
    if (band === 3) {
      // No key above, so the yellow key turns red at peak.
      if (n >= 3) frame[key(band, 2)] = n >= 4 ? 'r' : 'y';
      return;
    }
    if (n >= 3) frame[key(band, 2)] = 'y';
    if (n >= 4) frame[key(band, 1)] = 'r';
  });
  return frame;
}

const isLit = (state) => state !== undefined && state !== 'off';

// Requests land one at a time, so a change is only safe if it keeps the column solid:
// keys turn on from the bottom up and off from the top down.
function isSafe(id, target, shown) {
  if (isLit(shown[id]) === isLit(target)) return true;
  const [band, row] = id.match(/^vu-b(\d)-r(\d)$/).slice(1).map(Number);
  if (isLit(target)) return row === 4 || isLit(shown[key(band, row + 1)]);
  return !isLit(shown[key(band, row - 1)]);
}

// The next request to send: the largest group of safe changes that share a color,
// or null when the keys already show the frame.
export function nextRequest(frame, shown) {
  const groups = {};
  for (const id of KEYS) {
    if (frame[id] !== shown[id] && isSafe(id, frame[id], shown)) (groups[frame[id]] ??= []).push(id);
  }
  const [state, keys] = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  return state ? { state, keys } : null;
}

// setKeyLighting parameters for a request, without the deviceId.
export function lightingFor({ state, keys }) {
  const identifier = keys.length === 1 ? keys[0] : `vu-(${keys.map((id) => id.slice(3)).join('|')})`;
  const lighting = state === 'off' ? OFF : { color: COLORS[state], brightness: 1, effect: 1 };
  return { identifier, isRegex: keys.length > 1, ...lighting };
}
