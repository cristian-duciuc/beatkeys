import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Settings hold the Input credentials, so the file is readable only by you.
const directory = join(homedir(), 'Library', 'Application Support', 'beatkeys');
const file = join(directory, 'settings.json');

export async function loadSettings() {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveSettings(settings) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}
