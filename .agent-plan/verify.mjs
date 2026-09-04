#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = process.env.AGENT_PLAN_EVIDENCE_DIR;
const finalProofManifest = "final-proof-manifest.json";
const checks = [
  { name: "node scripts/test.mjs", args: ["scripts/test.mjs"] },
  { name: "node scripts/test.mjs --check", args: ["scripts/test.mjs", "--check"] }
];

function runCheck({ args, env = process.env }) {
  return new Promise((resolveCheck) => {
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, env, stdio: "inherit" });
    child.once("error", (error) => resolveCheck({ error }));
    child.once("exit", (code, signal) => resolveCheck({ code, signal }));
  });
}

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateImageData(chunks, { width, height, bitDepth, colorType }) {
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
  const validDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
  if (!channels || !validDepths.get(colorType)?.includes(bitDepth)) throw new Error("invalid PNG bit-depth/color-type combination");

  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const expectedLength = height * (rowBytes + 1);
  let image;
  try {
    image = inflateSync(Buffer.concat(chunks), { maxOutputLength: expectedLength });
  } catch (error) {
    throw new Error(`invalid IDAT zlib stream: ${error.message}`);
  }
  if (image.length !== expectedLength) throw new Error("IDAT scanlines do not match PNG dimensions");
  for (let row = 0; row < height; row++) {
    if (image[row * (rowBytes + 1)] > 4) throw new Error("invalid PNG scanline filter");
  }
}

async function validatePng(path) {
  const png = await readFile(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length <= signature.length || !png.subarray(0, signature.length).equals(signature)) throw new Error("not a non-empty PNG");

  let offset = signature.length;
  let header;
  let paletteEntries;
  const imageData = [];
  let imageDataEnded = false;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error("truncated PNG chunk");
    const length = png.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const crcStart = dataStart + length;
    const nextOffset = crcStart + 4;
    if (nextOffset > png.length) throw new Error("truncated PNG chunk data");
    const type = png.toString("ascii", typeStart, dataStart);
    if (png.readUInt32BE(crcStart) !== crc32(png, typeStart, crcStart)) throw new Error(`invalid ${type} chunk checksum`);

    if (!header) {
      if (type !== "IHDR" || length !== 13) throw new Error("missing complete IHDR chunk");
      header = {
        width: png.readUInt32BE(dataStart), height: png.readUInt32BE(dataStart + 4),
        bitDepth: png[dataStart + 8], colorType: png[dataStart + 9]
      };
      const compression = png[dataStart + 10];
      const filter = png[dataStart + 11];
      const interlace = png[dataStart + 12];
      if (!header.width || !header.height || header.width > 32768 || header.height > 32768 || header.width * header.height > 25000000) {
        throw new Error("invalid PNG dimensions");
      }
      if (compression !== 0 || filter !== 0 || interlace !== 0) throw new Error("unsupported IHDR encoding");
    } else if (type === "IHDR") {
      throw new Error("duplicate IHDR chunk");
    }

    if (type === "PLTE") {
      if (paletteEntries !== undefined) throw new Error("duplicate PLTE chunk");
      if (imageData.length) throw new Error("PLTE chunk must precede IDAT");
      if (header.colorType === 0 || header.colorType === 4) throw new Error("PLTE is not permitted for grayscale PNGs");
      if (!length || length % 3 || length > 768) throw new Error("invalid PLTE chunk size");
      paletteEntries = length / 3;
      if (header.colorType === 3 && paletteEntries > 2 ** header.bitDepth) throw new Error("PLTE has too many entries for indexed bit depth");
    }
    if (type === "IDAT") {
      if (imageDataEnded) throw new Error("non-consecutive IDAT chunks");
      imageData.push(png.subarray(dataStart, crcStart));
    } else if (imageData.length && type !== "IEND") {
      imageDataEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !imageData.length || nextOffset !== png.length) throw new Error("invalid IEND chunk");
      if (header.colorType === 3 && paletteEntries === undefined) throw new Error("indexed PNG is missing PLTE");
      validateImageData(imageData, header);
      return;
    }
    offset = nextOffset;
  }
  throw new Error("missing IEND chunk");
}

let failed = false;
const checkEnvironment = { ...process.env };
delete checkEnvironment.AGENT_PLAN_EVIDENCE_DIR;
const capturePath = resolve(repositoryRoot, ".agent-plan", "capture-proof-dashboard.mjs");
if (await stat(capturePath).then(() => true, () => false)) {
  process.stdout.write("Capturing criterion-proof dashboard evidence\n");
  const capture = await runCheck({ args: [".agent-plan/capture-proof-dashboard.mjs"], env: checkEnvironment });
  if (capture.error || capture.code !== 0) {
    failed = true;
    process.stderr.write(`Failed criterion-proof dashboard capture${capture.error ? `: ${capture.error.message}` : ""}\n`);
  }
}
for (const check of checks) {
  process.stdout.write(`Running ${check.name}\n`);
  const result = await runCheck({ ...check, env: checkEnvironment });
  if (result.error || result.code !== 0) {
    failed = true;
    process.stderr.write(`Failed ${check.name}${result.error ? `: ${result.error.message}` : result.signal ? `: terminated by ${result.signal}` : ""}\n`);
  }
}

if (evidenceDirectory) {
  const capture = { name: "node scripts/capture-final-proof.mjs", args: ["scripts/capture-final-proof.mjs"] };
  process.stdout.write(`Running ${capture.name}\n`);
  const result = await runCheck(capture);
  if (result.error || result.code !== 0) {
    failed = true;
    process.stderr.write(`Failed ${capture.name}${result.error ? `: ${result.error.message}` : result.signal ? `: terminated by ${result.signal}` : ""}\n`);
  } else {
    const outputDirectory = isAbsolute(evidenceDirectory) ? evidenceDirectory : resolve(repositoryRoot, evidenceDirectory);
    process.stdout.write("Validating dashboard evidence\n");
    try {
      const manifest = JSON.parse(await readFile(join(outputDirectory, finalProofManifest), "utf8"));
      if (manifest.source !== "live-ticket-run" || !manifest.identity?.ticketId || !manifest.identity?.runId || !Number.isInteger(manifest.identity?.revision) || Number.isNaN(Date.parse(manifest.capturedAt))) {
        throw new Error("manifest is not bound to a live ticket run, revision, and capture time");
      }
      const captures = manifest.captures || [];
      if (captures.length !== 2 || !["desktop", "mobile"].every((name) => captures.some((item) => item.name === name))) {
        throw new Error("manifest is missing desktop or mobile final proof");
      }
      for (const capture of captures) {
        if (capture.rendered?.ticketIdentifier !== manifest.identity.ticketIdentifier || capture.rendered?.ticketTitle !== manifest.identity.ticketTitle || capture.rendered?.workflow !== true || capture.rendered?.inspector !== true || !capture.rendered?.frame || capture.rendered?.focusedStageId !== (manifest.identity.focusedStageId || null) || capture.rendered?.focusedInspectorTitle !== (manifest.identity.focusedInspectorTitle || null)) {
          throw new Error(`${capture.name || "unknown"} proof did not confirm the selected ticket identity, active focus, and loaded workflow inspector`);
        }
        await validatePng(join(outputDirectory, capture.path.split(/[\\/]/).at(-1)));
      }
    } catch (error) {
      failed = true;
      process.stderr.write(`Failed dashboard evidence ${finalProofManifest}: ${error.message}\n`);
    }
  }
}

if (failed) process.exitCode = 1;
else process.stdout.write("Verification passed\n");
