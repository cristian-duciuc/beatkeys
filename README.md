# Beatkeys

Shows a 3-band VU meter of whatever your Mac is playing on the keys of a Work Louder
Creator Micro V2 or Codex Micro.

```
            col 1     col 2     col 3     col 4
row 1       ·         red       red       (knob)
row 2       play      yellow    yellow    yellow/red
row 3       ·         green     green     green
row 4       (stick)   green     green     green
                      low       mid       high
                      20–250 Hz 250 Hz–4k 4k–16 kHz
```

The high band has no key in row 1, so its yellow key turns red at peak.
The knob controls volume (press to mute), and column 1, row 2 is play/pause.

## Requirements

- macOS 14.2 or later (for Core Audio process taps)
- Xcode Command Line Tools (`xcode-select --install`) to build the audio tap
- Node.js 22.4 or later
- Work Louder Input, open, with a Creator Micro V2 or Codex Micro connected

## Setup

```sh
npm install              # also builds bin/audio-tap
npm run install-layer    # adds the VU Meter layer, then starts the meter
```

On the first run:

1. **Input** asks you to approve "Beatkeys". Approve it within 30 seconds.
2. **macOS** asks whether your terminal may record system audio. Allow it. If you
   miss it, enable your terminal under **System Settings › Privacy & Security ›
   Screen & System Audio Recording › System Audio Recording Only**. Without it the
   tap gets silence and the meter stays dark.

`install-layer` adds a layer named **VU Meter** to the active profile and switches to
it. A profile holds at most 6 layers. To remove it, delete the layer in Input.

## Run

```sh
npm start
```

It switches to the VU Meter layer and starts showing the meter. Press `Ctrl+C` to stop;
the keys turn dark. If you switch to another layer, the meter pauses and picks up again
when you come back.

## Tuning

```sh
npm run levels
```

Prints the level of each band in dBFS twice a second without touching the device.
Play some music and adjust `STEP_DB` (where each step lights) and `BAND_GAIN_DB` in
`src/analyzer.mjs`.

## How it works

- `tap/AudioTap.swift` creates a Core Audio process tap of all apps, mixed to mono, and
  writes raw 32-bit float samples to stdout.
- `src/analyzer.mjs` runs an FFT about 30 times a second, sums each band, and applies a
  fast rise and a slow fall.
- `src/meter.mjs` turns band levels into key colors and picks the next lighting request.
- `src/main.mjs` connects to Input with `@worklouder/input-kit` and sends one
  `setKeyLighting` request at a time.

Credentials are stored in `~/Library/Application Support/beatkeys/settings.json`,
readable only by you.

## Known limits

- **Slow updates.** Input accepts 40 lighting requests per 10 seconds per device over BLE
  (60 over USB), and InputKit spaces them 250 ms apart. Each request sets one color for a
  group of keys, so the meter changes about 4 times per second. It lags the music and skips
  beats. Other apps that light the same device share that budget; when Input turns a request
  down, the meter waits a second and carries on.
- **Ordered changes.** Keys turn on from the bottom up and off from the top down, so a
  column never shows red without yellow under it. This makes big jumps take several
  requests.
- **Output device.** The tap follows the output device that was active at start. Restart
  after switching between speakers and headphones.

## License

MIT. See [LICENSE](LICENSE).
