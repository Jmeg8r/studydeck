// WHAT: resolveTool, which finds an operator tool such as ffmpeg or ffprobe.
// WHY:  launchd starts the cockpit with a minimal PATH that often omits Apple Silicon
//       Homebrew, so a bare name can fail under the service while working in a terminal.
//       Same order as videogeneration.mjs's private tool(): a configured path that exists,
//       then known install directories, then PATH. That module is left as it is; moving it
//       here is a separate cleanup (chapter-audio-assembly).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The path to run for `name`: `$envName` if it exists, then `dirs` in order, else `name`. */
export function resolveTool(envName, name, dirs = TOOL_DIRS) {
  const candidates = [process.env[envName], ...dirs.map((dir) => join(dir, name))].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? name;
}
