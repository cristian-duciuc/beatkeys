import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { bandLevels } from '../src/analyzer.mjs';
import { KEYS, ROWS, frameFor, lightingFor, nextRequest, offState } from '../src/meter.mjs';
import * as volume from '../src/volume.mjs';

const isLit = (state) => state !== 'off';

function assertSolid(shown) {
  for (const [band, rows] of Object.entries(ROWS)) {
    // rows run bottom to top, so once a key is dark every key above must be dark too
    const states = rows.map((row) => shown[`vu-b${band}-r${row}`]);
    const firstDark = states.findIndex((state) => !isLit(state));
    if (firstDark >= 0) assert.ok(states.slice(firstDark).every((state) => !isLit(state)), `band ${band}: ${states}`);
  }
}

test('frameFor lights steps from the bottom', () => {
  const frame = frameFor([4, 2, 4]);
  assert.equal(frame['vu-b1-r4'], 'g');
  assert.equal(frame['vu-b1-r3'], 'g');
  assert.equal(frame['vu-b1-r2'], 'y');
  assert.equal(frame['vu-b1-r1'], 'r');
  assert.equal(frame['vu-b2-r2'], 'off');
  assert.equal(frame['vu-b3-r2'], 'r', 'band 3 turns its yellow key red at peak');
});

test('nextRequest never leaves a gap and always reaches the frame', () => {
  let shown = offState();
  for (let round = 0; round < 500; round++) {
    const target = frameFor([0, 1, 2].map(() => Math.floor(Math.random() * 5)));
    for (let request = nextRequest(target, shown), sent = 0; request; request = nextRequest(target, shown)) {
      for (const id of request.keys) shown[id] = request.state;
      assertSolid(shown);
      assert.ok(++sent <= KEYS.length);
    }
    assert.deepEqual(shown, target);
  }
});

test('lightingFor groups keys into one regex', () => {
  assert.deepEqual(lightingFor({ state: 'off', keys: ['vu-b1-r1', 'vu-b2-r1'] }), {
    identifier: 'vu-(b1-r1|b2-r1)',
    isRegex: true,
    color: 0,
    brightness: 0,
    effect: 1,
  });
  assert.deepEqual(lightingFor({ state: 'g', keys: ['vu-b3-r4'] }), {
    identifier: 'vu-b3-r4',
    isRegex: false,
    color: 0x00ff00,
    brightness: 1,
    effect: 1,
  });
});

test('bandLevels puts a tone in the right band', () => {
  const rate = 48000;
  const tone = (hz) => Float32Array.from({ length: 2048 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  for (const [hz, band] of [[100, 0], [1000, 1], [8000, 2]]) {
    const levels = bandLevels(tone(hz), rate);
    assert.equal(levels.indexOf(Math.max(...levels)), band, `${hz} Hz: ${levels}`);
  }
});

test('the layer has an API key for every meter key', async () => {
  const layer = JSON.parse(await readFile(new URL('../resources/vu-layer.json', import.meta.url), 'utf8'));
  const identifiers = layer.smartActions.map(({ payload }) => payload.id).sort();
  assert.deepEqual(identifiers, [...KEYS].sort());
  assert.deepEqual(layer.layer.layout.base.map((row) => row.length), [2, 4, 4, 3]);
});

test('the volume layer has an API key for every volume key', async () => {
  const layer = JSON.parse(await readFile(new URL('../resources/volume-layer.json', import.meta.url), 'utf8'));
  const identifiers = layer.smartActions.map(({ payload }) => payload.id);
  assert.ok(volume.KEYS.every((id) => identifiers.includes(id)));
  assert.equal(layer.layer.layout.base[1][0].keycode, 'SA_12');
});

test('the volume bar fills rows 1 and 2 from the left and reaches the frame', () => {
  const quiet = volume.frameFor(volume.LEVEL_DB[0] - 1);
  assert.ok(volume.KEYS.every((id) => quiet[id] === 'off'));
  const middle = volume.frameFor(volume.LEVEL_DB[1] + 1);
  volume.COLUMNS.forEach((keys, column) => {
    for (const id of keys) assert.equal(middle[id], column < 2 ? 'g' : 'off', id);
  });
  assert.equal(volume.frameFor(0)['vu-b3-r2'], 'r');
  for (let round = 0, shown = volume.offState(); round < 200; round++) {
    const target = volume.frameFor(volume.LEVEL_DB[0] - 5 + Math.random() * 30);
    for (let request = volume.nextRequest(target, shown), sent = 0; request; request = volume.nextRequest(target, shown)) {
      for (const id of request.keys) shown[id] = request.state;
      assert.ok(++sent <= volume.COLUMNS.length);
    }
    assert.deepEqual(shown, target);
  }
});
