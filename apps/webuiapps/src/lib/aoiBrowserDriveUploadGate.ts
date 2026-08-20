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
import { loadAoiHostWriteRoots } from './aoiHostFileWrite';
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
  // Which direction is being decided. Only the wording depends on it, but the
  // wording is what the operator acts on: a download refused with "no read roots
  // are registered" sends them to edit the wrong list.
  kind: 'upload' | 'download' = 'upload',
): AoiBrowserDriveUploadDecision {
  const rootNoun = kind === 'upload' ? 'read' : 'write';
  const direction = kind === 'upload' ? 'upload from' : 'download to';
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
      reason: `no ${rootNoun} roots are registered, so there is nowhere Aoi may ${direction}`,
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
    reason: `that path is outside every registered ${rootNoun} root; register it first if this is intended`,
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
/**
 * Re-check the REAL path against the REAL roots.
 *
 * The string containment check answers "does this path spell out somewhere
 * inside a root", which is not the same question as "is this file inside a
 * root". A directory junction planted inside a root -- and on Windows a
 * junction needs no administrator -- makes any file on the machine spell out
 * correctly: `<root>\out\id_rsa` passes containment, and the lstat below sees
 * a perfectly ordinary file, because only the LAST component is ever stat'd.
 *
 * So resolve every intermediate component and ask again. The roots are resolved
 * too, otherwise a root that itself lives behind a symlink (the usual /tmp ->
 * /private/tmp) would refuse files that are genuinely inside it.
 *
 * This is the check the read, write and delete paths already do; these two gates
 * were the ones missing it.
 */
function checkRealPathInsideRoots(
  absolute: string,
  roots: string[],
  kind: 'upload' | 'download',
): AoiBrowserDriveUploadDecision {
  let real: string;
  try {
    real = fs.realpathSync.native(absolute);
  } catch {
    return { allowed: false, reason: 'that path could not be resolved' };
  }
  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(fs.realpathSync.native(resolve(root)));
    } catch {
      // A configured root that no longer resolves is skipped, not fatal -- the
      // same handling the read path uses. Skipping can only refuse more.
    }
  }
  const decision = decideAoiBrowserDriveUpload(real, realRoots, kind);
  if (decision.allowed) {
    return decision;
  }
  if (real.toLowerCase() === absolute.toLowerCase()) {
    return decision;
  }
  // Name the path it actually resolved to. "outside every registered root" for a
  // path that plainly reads as inside one is the kind of answer that gets argued
  // with rather than acted on.
  return {
    allowed: false,
    reason: `that path resolves to ${real}, which is outside every registered ${
      kind === 'upload' ? 'read' : 'write'
    } root`,
  };
}

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
    return checkRealPathInsideRoots(resolve(filePath.trim()), roots, 'upload');
  };
}

/**
 * Where a download may be written.
 *
 * The mirror of the upload gate, bounded by WRITE roots rather than read roots.
 * A download is the reverse direction -- bytes the page chose, landing on the
 * operator's disk -- so the bound is the list that already says where Aoi may
 * write at all, and the same DENY default applies when no gate is wired.
 *
 * The destination must be a DIRECTORY that already exists: creating one would
 * be a second effect nobody asked for, and letting the browser invent the path
 * would put the page in charge of where its own file lands.
 */
export function buildAoiBrowserDriveDownloadGate(openroomHome: string): AoiBrowserDriveUploadGate {
  return (directory: string) => {
    const config = loadAoiHostWriteRoots(openroomHome);
    const roots = config.roots.map((entry) => entry.path);
    const decision = decideAoiBrowserDriveUpload(directory, roots, 'download');
    if (!decision.allowed) {
      return decision;
    }
    try {
      const stats = fs.lstatSync(resolve(directory.trim()));
      if (stats.isSymbolicLink()) {
        return { allowed: false, reason: 'symlinked directories are not used; give the real path' };
      }
      if (!stats.isDirectory()) {
        return { allowed: false, reason: 'the download destination must be a directory' };
      }
    } catch {
      return { allowed: false, reason: 'that directory does not exist' };
    }
    return checkRealPathInsideRoots(resolve(directory.trim()), roots, 'download');
  };
}
