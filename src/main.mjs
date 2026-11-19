import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { InputApiError, InputClient, InputDeviceRateLimitError } from '@worklouder/input-kit';
import { Analyzer, BANDS } from './analyzer.mjs';
import * as meter from './meter.mjs';
import * as volume from './volume.mjs';
import { loadSettings, saveSettings } from './store.mjs';

const APP_NAME = 'Beatkeys';
const SUPPORTED = new Set(['codex_micro', 'creator_micro_v2', 'creator_micro_v2_base', 'creator_micro_v2_pro']);
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000];

const args = new Set(process.argv.slice(2));
let installLayer = args.has('--install-layer');
const analyzer = new Analyzer();
// `--volume` shows only the overall level on rows 1 and 2, on its own layer, instead of the 3-band meter.
const view = args.has('--volume')
  ? { ...volume, frame: () => volume.frameFor(analyzer.volume), layer: 'volumeLayer', file: 'volume-layer.json', name: 'VU Volume', install: 'install-volume-layer' }
  : { ...meter, frame: () => meter.frameFor(analyzer.steps()), layer: 'layer', file: 'vu-layer.json', name: 'VU Meter', install: 'install-layer' };
let settings = await loadSettings();
let input = null;
let currentDevice = null;
let stopping = false;

const isApiError = (error, code) => error instanceof InputApiError && error.code === code;

function startTap() {
  const binary = fileURLToPath(new URL('../bin/audio-tap', import.meta.url));
  const tap = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  tap.on('error', (error) => {
    console.error(`Can't start the audio tap (${error.message}). Run \`npm run build\` first.`);
    process.exit(1);
  });
  tap.on('exit', (code) => {
    if (stopping) return;
    console.error(`The audio tap stopped (exit code ${code}).`);
    process.exit(1);
  });
  tap.stderr.setEncoding('utf8').on('data', (text) => {
    for (const line of text.trim().split('\n')) {
      const rate = line.match(/^rate (\d+)$/);
      if (rate) analyzer.sampleRate = Number(rate[1]);
      else console.error(`audio-tap: ${line}`);
    }
  });
  // Samples arrive as raw 32-bit floats, and a chunk can end mid-sample.
  let rest = Buffer.alloc(0);
  tap.stdout.on('data', (chunk) => {
    const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const usable = data.length - (data.length % 4);
    analyzer.push(new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + usable)));
    rest = data.subarray(usable);
  });
  return tap;
}

async function connect() {
  for (let attempt = 0; !stopping; attempt++) {
    const client = new InputClient({ applicationName: APP_NAME });
    try {
      await client.connect();
      if (settings.credentials) {
        await client.authenticate(settings.credentials);
      } else {
        console.log(`Approve "${APP_NAME}" in Input within 30 seconds.`);
        settings.credentials = await client.requestAuthorization();
        await saveSettings(settings);
      }
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (isApiError(error, -32001) && settings.credentials) {
        console.log('Input no longer accepts this app. Asking for approval again.');
        delete settings.credentials;
        await saveSettings(settings);
        continue;
      }
      if (isApiError(error, -32003)) throw new Error('The approval was declined in Input.');
      const wait = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
      console.log(`Can't reach Input (${error.message}). Make sure it's open. Retrying in ${wait / 1000} s.`);
      await delay(wait);
    }
  }
  return null;
}

async function findDevice(client) {
  for (;;) {
    const device = (await client.getDevices()).find(({ deviceType }) => SUPPORTED.has(deviceType));
    if (device) return device;
    console.log('Waiting for a Creator Micro V2 or Codex Micro. Connect it and wait for Input to load it.');
    await delay(5000);
  }
}

// Adds the view's layer to the active profile and remembers where it went.
async function addLayer(client, deviceId) {
  const info = await client.getDeviceInfo(deviceId);
  const profileIndex = info.deviceStatus?.selectedProfileIndex ?? 0;
  const definition = JSON.parse(await readFile(new URL(`../resources/${view.file}`, import.meta.url), 'utf8'));
  console.log(`Adding the ${view.name} layer to profile ${profileIndex + 1}...`);
  await client.addLayer({ deviceId, profileIndex, definition });
  // A new layer goes last. Selecting from layer 6 down finds it: missing layers fail with -32015.
  for (let layerIndex = 6; layerIndex >= 1; layerIndex--) {
    try {
      await client.setActiveProfileLayer({ deviceId, profileIndex, layerIndex });
      settings[view.layer] = { profileIndex, layerIndex };
      await saveSettings(settings);
      console.log(`Added it as layer ${layerIndex} of profile ${profileIndex + 1}.`);
      return;
    } catch (error) {
      if (!isApiError(error, -32015)) throw error;
    }
  }
  throw new Error('Added the layer but could not find it on the profile.');
}

// Other apps share the device's rate limit, so Input can still turn a request down. Then this waits
// and returns false, and the caller works out the next request again.
async function setLighting(client, params) {
  try {
    await client.setKeyLighting(params);
    return true;
  } catch (error) {
    if (!(error instanceof InputDeviceRateLimitError)) throw error;
    await delay(1000);
    return false;
  }
}

// Sends one request at a time. InputKit spaces lighting requests 250 ms apart per device,
// which keeps under the rate limit.
async function render(client, deviceId) {
  const { profileIndex, layerIndex } = settings[view.layer];
  let active = true;
  let shown = null; // null means the keys are in an unknown state and need a reset
  client.on('deviceInfoChanged', ({ deviceId: id, deviceInfo }) => {
    if (id !== deviceId) return;
    const status = deviceInfo.deviceStatus ?? {};
    const isMeter = status.selectedProfileIndex === profileIndex && status.selectedLayerIndex === layerIndex;
    if (isMeter && !active) shown = null;
    active = isMeter;
  });

  while (!stopping && client.connected) {
    if (!active) {
      await delay(250);
      continue;
    }
    if (!shown) {
      if (await setLighting(client, { deviceId, identifier: meter.ALL_KEYS, isRegex: true, ...meter.OFF })) {
        shown = view.offState();
      }
      continue;
    }
    const request = view.nextRequest(view.frame(), shown);
    if (!request) {
      await delay(30);
      continue;
    }
    if (await setLighting(client, { deviceId, ...view.lightingFor(request) })) {
      for (const id of request.keys) shown[id] = request.state;
    }
  }
}

async function run() {
  while (!stopping) {
    input = await connect();
    if (!input) return;
    try {
      const { id: deviceId } = await findDevice(input);
      currentDevice = deviceId;
      if (installLayer) {
        await addLayer(input, deviceId);
        installLayer = false;
      } else if (!settings[view.layer]) {
        console.log(`The ${view.name} layer is not installed yet. Run \`npm run ${view.install}\` first.`);
        return;
      } else {
        await input.setActiveProfileLayer({ deviceId, ...settings[view.layer] });
      }
      console.log('Showing the meter. Play something. Press Ctrl+C to stop.');
      await render(input, deviceId);
    } catch (error) {
      if (isApiError(error, -32009) || isApiError(error, -32015)) {
        console.log(`The ${view.name} layer is gone from the device. Run \`npm run ${view.install}\` to add it again.`);
        delete settings[view.layer];
        await saveSettings(settings);
        return;
      }
      if (!stopping) console.error(`Lost the device or Input (${error.message}). Reconnecting...`);
    } finally {
      await input.close().catch(() => {});
    }
    if (!stopping) await delay(2000);
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (input?.connected && currentDevice) {
    // Leave the keys dark, but don't wait long if Input doesn't answer.
    const off = input.setKeyLighting({ deviceId: currentDevice, identifier: meter.ALL_KEYS, isRegex: true, ...meter.OFF });
    await Promise.race([off.catch(() => {}), delay(1500)]);
  }
  await input?.close().catch(() => {});
  tap.kill();
  process.exit(0);
}

const tap = startTap();
setInterval(() => analyzer.update(performance.now() / 1000), 33);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (args.has('--levels')) {
  // Prints band levels so you can tune STEP_DB in src/analyzer.mjs. Doesn't touch the device.
  setInterval(() => {
    const levels = analyzer.levels.map((db, band) => `${BANDS[band].join('-')} Hz ${db.toFixed(1).padStart(6)} dB`);
    console.log(`${levels.join('   ')}   steps ${analyzer.steps().join(' ')}   volume ${analyzer.volume.toFixed(1)} dB`);
  }, 500);
} else {
  run()
    .catch((error) => console.error(error.message))
    .finally(stop);
}
