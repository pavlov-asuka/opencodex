/**
 * Tool-result screenshots must be shrunk on Windows too.
 *
 * The only resizer was sips, which returns null off macOS. On Windows — the
 * platform this fork targets — that meant every oversized screenshot went to
 * the provider at full resolution: context and quota spent on pixels no model
 * needed, and an outright failure against providers with a hard attachment
 * limit. The guard made it silent, so it looked like the feature worked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { platformImageProcessor } from "../dist/services/computer_use_image_compat.js";

const isWindows = process.platform === "win32";

/** A real PNG, produced by the same imaging stack the resizer uses. */
async function makePng(width, height) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-img-src-"));
  const file = path.join(dir, "source.png");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", [
      "Add-Type -AssemblyName System.Drawing",
      `$b=New-Object Drawing.Bitmap(${width},${height})`,
      "$g=[Drawing.Graphics]::FromImage($b)",
      "$g.Clear([Drawing.Color]::CornflowerBlue)",
      "$g.FillEllipse([Drawing.Brushes]::Orange,10,10,200,200)",
      "$g.Dispose()",
      `$b.Save('${file.replace(/\\/g, "\\\\")}',[Drawing.Imaging.ImageFormat]::Png)`,
      "$b.Dispose()",
    ].join("\n")],
    { windowsHide: true, stdio: "ignore" },
  );
  const buffer = await fs.readFile(file);
  await fs.rm(dir, { recursive: true, force: true });
  return buffer;
}

/** Width and height straight out of the PNG IHDR. */
function pngDimensions(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("Windows has a resizer at all", { skip: !isWindows }, () => {
  assert.notEqual(platformImageProcessor(), null, "an unoptimized screenshot is a real cost, not a no-op");
});

test("an oversized screenshot is scaled down to the limit", { skip: !isWindows }, async () => {
  const source = await makePng(1600, 900);
  assert.deepEqual(pngDimensions(source), { width: 1600, height: 900 });

  const processed = await platformImageProcessor()({
    buffer: source,
    mimeType: "image/png",
    maxEdge: 800,
    jpegQuality: 80,
  });

  assert.ok(processed, "the resizer must produce an image");
  assert.equal(processed.mimeType, "image/png", "a PNG stays a PNG");
  const dimensions = pngDimensions(processed.buffer);
  assert.equal(dimensions.width, 800, "the long edge lands on the limit");
  assert.equal(dimensions.height, 450, "the aspect ratio is preserved");
});

test("a JPEG source comes back as a JPEG", { skip: !isWindows }, async () => {
  const source = await makePng(1200, 1200);
  const processed = await platformImageProcessor()({
    buffer: source,
    mimeType: "image/jpeg",
    maxEdge: 600,
    jpegQuality: 70,
  });

  assert.ok(processed);
  assert.equal(processed.mimeType, "image/jpeg");
  assert.equal(processed.buffer[0], 0xff, "a JPEG starts with the SOI marker");
  assert.equal(processed.buffer[1], 0xd8);
  assert.ok(processed.buffer.length < source.length, "re-encoding a photo-sized bitmap should save bytes");
});

test("a corrupt image is refused rather than thrown", { skip: !isWindows }, async () => {
  const processed = await platformImageProcessor()({
    buffer: Buffer.from("this is not an image"),
    mimeType: "image/png",
    maxEdge: 800,
    jpegQuality: 80,
  });
  assert.equal(processed, null, "the caller keeps the original when optimization fails");
});
