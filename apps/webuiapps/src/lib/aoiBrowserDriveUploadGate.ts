// Upload gate (BU1): decides whether a local file may be attached to a page.
//
// Uploading is the one browser action that moves data OUT of the machine, and
// the path is chosen inside a plan a hostile page can influence -- "attach the
// file at ~/.ssh/id_rsa to this form" is one step away otherwise. So the path is
// not the model's to pick freely.
//
// The bound is the operator's registered READ ROOTS: the same list that already
// says which files Aoi may read at all. A file Aoi could not read is a file it
// cannot upload, which keeps one answer to "what can Aoi see" rather than two.
//
// Server-only (fs). The decision itself is a pure function of the roots so it
// can be tested without a filesystem.
import * as fs from 'fs';
import { isAbsolute, resolve } from 'path';

import { isAoiPathInsideRoot, loadAoiHostReadRoots } from './aoiHostFileRead';
import type { AoiBrowserDriveUploadGate } from './aoiBrowserDriveExecutor';

export interface AoiBrowserDriveUploadDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Pure decision: is this path inside one of the registered roots?
 *
 * Relative paths are refused outright rather than resolved against whatever the
 * daemon's working directory happens to be -- that would make the same plan mean
 * different files on different machines.
 */
export function decideAoiBrowserDriveUpload(
  filePath: string,
  roots: string[],
): AoiBrowserDriveUploadDecision {
  const raw = typeof filePath === 'string' ? filePath.trim() : '';
  if (!raw) {
    return { allowed: false, reason: 'no file path was given' };
  }
  if (!isAbsolute(raw)) {
    return { allowed: false, reason: 'the file path must be absolute' };
  }
  if (raw.includes('\0')) {
    return { allowed: false, reason: 'the file path is malformed' };
  }
  if (!roots.length) {
    return {
      allowed: false,
      reason: 'no read roots are registered, so there is nowhere Aoi may upload from',
    };
  }
  const target = resolve(raw);
  for (const root of roots) {
    if (isAoiPathInsideRoot(root, target)) {
      return { allowed: true, reason: `inside the registered root ${root}` };
    }
  }
  return {
    allowed: false,
    reason: 'the file is outside every registered read root; register it first if this is intended',
  };
}

/**
 * Production gate: registered roots, and the file must actually be a file.
 *
 * The stat is not redundant with the path check. Without it a directory or a
 * dangling symlink reaches the browser layer and fails there as an opaque
 * transport error, which reads to the model as "the site rejected it" rather
 * than "that is not a file".
 */
export function buildAoiBrowserDriveUploadGate(openroomHome: string): AoiBrowserDriveUploadGate {
  return (filePath: string) => {
    const config = loadAoiHostReadRoots(openroomHome);
    const roots = config.roots.map((entry) => entry.path);
    const decision = decideAoiBrowserDriveUpload(filePath, roots);
    if (!decision.allowed) {
      return decision;
    }
    try {
      // lstat, not stat: a symlink pointing out of the roots must not be
      // followed into somewhere the path check just refused.
      const stats = fs.lstatSync(resolve(filePath.trim()));
      if (stats.isSymbolicLink()) {
        return { allowed: false, reason: 'symlinks are not uploaded; give the real path' };
      }
      if (!stats.isFile()) {
        return { allowed: false, reason: 'that path is not a file' };
      }
    } catch {
      return { allowed: false, reason: 'that file does not exist' };
    }
    return decision;
  };
}
