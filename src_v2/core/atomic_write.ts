/**
 * Durable writes for the files OpenCodex cannot afford to truncate.
 *
 * The model catalog, the provider configuration and the routing setting were
 * all written with a plain writeFileSync straight over the final path. A crash,
 * a full disk, or an antivirus product holding the handle mid-write left an
 * empty or half-written file — and for providers.json that means every
 * configured model and endpoint gone, with the credentials still sitting in
 * the OS store.
 *
 * Same-directory temp file, then rename, which is atomic on both NTFS and
 * APFS for a replace within one volume.
 */
import fs from "node:fs";
import path from "node:path";

export function writeFileAtomic(filePath: string, contents: string, mode = 0o600): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let handle: number | null = null;
  try {
    handle = fs.openSync(temporaryPath, "w", mode);
    fs.writeFileSync(handle, contents, "utf-8");
    // Without the flush the rename can land ahead of the data, which is the
    // one failure this whole function exists to prevent.
    try { fs.fsyncSync(handle); } catch {}
    fs.closeSync(handle);
    handle = null;

    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, mode); } catch {}
  } catch (error) {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}
