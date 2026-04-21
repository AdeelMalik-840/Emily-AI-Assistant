/**
 * Normalizes to a JPEG WhatsApp will classify as a photo (not a sticker):
 * realistic dimensions, opaque pixels, embedded metadata, sufficient file size.
 */

import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import sharp from "sharp";

/** WhatsApp may treat very small files as sticker-like assets. */
const MIN_JPEG_BYTES = 10_240;

/**
 * @param {Buffer} input
 * @param {string} outputPath
 * @param {number} box max width/height
 * @param {number} quality jpeg quality 1–100
 */
async function writePhotoJpeg(input, outputPath, box, quality) {
  await sharp(input)
    .resize({ width: box, height: box, fit: "inside" })
    .flatten({ background: "#ffffff" })
    .withMetadata()
    .jpeg({ quality })
    .toFile(outputPath);
}

/**
 * @param {Buffer | string} inputPathOrBuffer - File path or raw buffer (never sent as-is)
 * @returns {Promise<string>} Path to temp `.jpg` (caller schedules delayed delete after upload)
 */
export async function normalizeWhatsAppImage(inputPathOrBuffer) {
  const outputPath = path.join(
    tmpdir(),
    `photo-${Date.now()}-${randomBytes(4).toString("hex")}.jpg`
  );

  const input =
    Buffer.isBuffer(inputPathOrBuffer) ?
      inputPathOrBuffer
    : await readFile(inputPathOrBuffer);

  await writePhotoJpeg(input, outputPath, 1280, 92);

  let st = await stat(outputPath);
  if (st.size < MIN_JPEG_BYTES) {
    await writePhotoJpeg(await readFile(outputPath), outputPath, 1920, 96);
    st = await stat(outputPath);
  }
  if (st.size < MIN_JPEG_BYTES) {
    await writePhotoJpeg(await readFile(outputPath), outputPath, 2560, 98);
  }

  return outputPath;
}
