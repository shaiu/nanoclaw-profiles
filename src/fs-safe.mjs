import fs from 'node:fs';
import path from 'node:path';

// Every read under an agent-writable group folder must go through here.
// The agent controls that folder's contents (NanoClaw mounts it read-write
// into the container) and can plant symlinks pointing anywhere on the host
// or into another group's folder. realpath-containment is the only reliable
// defence: resolve both the base directory and the requested target to
// their real (symlink-free) paths, and refuse anything whose real path
// falls outside the real base.

/**
 * Resolve `rel` against `baseDir` and return its realpath, or null if
 * `baseDir` or the target don't exist, or the target's realpath is not
 * strictly inside the base's realpath.
 */
export function realInside(baseDir, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  let realBase;
  try {
    realBase = fs.realpathSync(baseDir);
  } catch {
    return null;
  }
  let real;
  try {
    real = fs.realpathSync(path.resolve(baseDir, rel));
  } catch {
    return null;
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
  return real;
}

/** Like realInside, but only returns a path that is a real directory. */
export function realDirInside(baseDir, rel) {
  const real = realInside(baseDir, rel);
  if (!real) return null;
  try {
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Reads `rel` as utf8 text, or returns null if it's not a contained regular file. */
export function readFileInside(baseDir, rel) {
  const real = realInside(baseDir, rel);
  if (!real) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
    return fs.readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}
