import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Request, RequestHandler, Response } from "express";
import multer from "multer";
import JSZip from "jszip";
import { deleteFile, quarantineStorageKey, uploadFileStream } from "./storage";
import { extractExtension, sniffRasterImageMime } from "./uploadTypes";
import { assertBetaDataPolicy, BetaPolicyError } from "./betaPolicy";
import { createServerSupabase } from "./supabase";
import { claimWorkerLease, workerInstanceId } from "./workers/leases";

export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_MB = Math.round(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024));
export const MAX_AUDIO_UPLOAD_SIZE_BYTES = 250 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_SIZE_MB = Math.round(MAX_AUDIO_UPLOAD_SIZE_BYTES / (1024 * 1024));

const tempRoot = path.join(os.tmpdir(), "cocoa-legal-quarantine");
const diskStorage = multer.diskStorage({
  destination(_req, _file, callback) {
    fs.mkdir(tempRoot, { recursive: true }, (error) => callback(error, tempRoot));
  },
  filename(_req, _file, callback) {
    callback(null, crypto.randomUUID());
  },
});

function upload(maxBytes: number) {
  return multer({ storage: diskStorage, limits: { fileSize: maxBytes, files: 1 } });
}

function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export type MalwareScanResult =
  | { status: "clean" }
  | { status: "infected"; signature: string }
  | { status: "unavailable"; reason: string };

export function parseClamAvResponse(response: string): MalwareScanResult {
  const normalized = response.replaceAll("\0", "").trim();
  if (normalized.endsWith(" OK")) return { status: "clean" };
  const found = normalized.match(/:\s*(.+)\s+FOUND$/);
  if (found) return { status: "infected", signature: found[1].slice(0, 200) };
  return { status: "unavailable", reason: normalized.slice(0, 200) || "empty scanner response" };
}

function startsWith(bytes: Buffer, magic: number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

export async function validateUploadContainer(
  bytes: Buffer,
  filename: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const extension = extractExtension(filename);
  const zipExtensions = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"]);
  const textExtensions = new Set(["csv", "html", "htm", "txt", "md"]);
  const magicChecks: Record<string, boolean> = {
    pdf: bytes.subarray(0, 5).toString("ascii") === "%PDF-",
    png: startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]),
    jpg: startsWith(bytes, [0xff, 0xd8, 0xff]),
    jpeg: startsWith(bytes, [0xff, 0xd8, 0xff]),
    gif: bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a",
    webp: bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP",
    doc: startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]),
    xls: startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]),
    ppt: startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]),
    rtf: bytes.subarray(0, 5).toString("ascii") === "{\\rtf",
    wav: bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE",
    ogg: bytes.subarray(0, 4).toString("ascii") === "OggS",
    flac: bytes.subarray(0, 4).toString("ascii") === "fLaC",
    webm: startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]),
    m4a: bytes.subarray(4, 8).toString("ascii") === "ftyp",
  };
  const rasterExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
  if (extension === "mp3") {
    const mp3 = bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    if (!mp3) return { ok: false, reason: "File contents do not match the declared MP3 type." };
  } else if (rasterExtensions.has(extension) && !sniffRasterImageMime(bytes)) {
    return { ok: false, reason: "File contents are not a supported raster image." };
  } else if (!rasterExtensions.has(extension) && extension in magicChecks && !magicChecks[extension]) {
    return { ok: false, reason: `File contents do not match the declared ${extension.toUpperCase()} type.` };
  }
  if (textExtensions.has(extension)) {
    if (bytes.includes(0))
      return { ok: false, reason: "The text file contains binary data." };
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: "The text file is not valid UTF-8." };
    }
  }

  if (zipExtensions.has(extension)) {
    if (!startsWith(bytes, [0x50, 0x4b]))
      return { ok: false, reason: "The archive container is malformed." };
    try {
      const archive = await JSZip.loadAsync(bytes, { checkCRC32: false });
      const entries = Object.values(archive.files);
      if (entries.length > 5_000)
        return { ok: false, reason: "The archive contains too many entries." };
      if (entries.some((entry) => entry.name.split(/[\\/]+/).includes("..")))
        return { ok: false, reason: "The archive contains an unsafe path." };
      const expandedBytes = entries.reduce((total, entry) => {
        const metadata = entry as unknown as { _data?: { uncompressedSize?: number } };
        return total + Math.max(0, Number(metadata._data?.uncompressedSize ?? 0));
      }, 0);
      if (expandedBytes > 500 * 1024 * 1024 || expandedBytes > Math.max(bytes.length * 100, 20 * 1024 * 1024))
        return { ok: false, reason: "The archive exceeds safe expansion limits." };
    } catch {
      return { ok: false, reason: "The archive container is malformed." };
    }
  }
  return { ok: true };
}

export async function scanFileWithClamAv(filePath: string): Promise<MalwareScanResult> {
  const host = process.env.CLAMAV_HOST;
  const port = Number.parseInt(process.env.CLAMAV_PORT ?? "3310", 10);
  if (!host) return { status: "unavailable", reason: "CLAMAV_HOST is not configured" };
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let response = "";
    let settled = false;
    const finish = (result: MalwareScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(Number(process.env.CLAMAV_TIMEOUT_MS ?? 30_000));
    socket.on("timeout", () => finish({ status: "unavailable", reason: "scanner timeout" }));
    socket.on("error", (error) => finish({ status: "unavailable", reason: error.message }));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("end", () => finish(parseClamAvResponse(response)));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      stream.on("data", (rawChunk: string | Buffer) => {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      });
      stream.on("end", () => socket.end(Buffer.alloc(4)));
      stream.on("error", (error) => finish({ status: "unavailable", reason: error.message }));
    });
  });
}

export async function checkClamAvReachable(): Promise<void> {
  const host = process.env.CLAMAV_HOST;
  if (!host) throw new Error("CLAMAV_HOST is not configured");
  const port = Number.parseInt(process.env.CLAMAV_PORT ?? "3310", 10);
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = "";
    socket.setTimeout(2_000);
    socket.on("connect", () => socket.end("zPING\0"));
    socket.on("data", (chunk) => (response += chunk.toString("utf8")));
    socket.on("timeout", () => reject(new Error("scanner timeout")));
    socket.on("error", reject);
    socket.on("close", () =>
      response.includes("PONG")
        ? resolve()
        : reject(new Error("scanner did not return PONG")),
    );
  });
}

/** Email intake uses the same scanner and container validation as HTTP uploads. */
export async function validateEmailAttachmentBytes(bytes: Buffer, filename: string): Promise<void> {
  if (bytes.length > MAX_UPLOAD_SIZE_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cocoa-email-scan-"));
  try {
    const file = path.join(dir, "attachment");
    await fsPromises.writeFile(file, bytes, { mode: 0o600 });
    const scan = await scanFileWithClamAv(file);
    if (scan.status === "infected") throw new Error("MALWARE_DETECTED");
    if (scan.status === "unavailable" && (boolEnv("BETA_MODE") || boolEnv("UPLOAD_SCANNING_REQUIRED")))
      throw new Error("UPLOAD_SCAN_UNAVAILABLE");
    const validation = await validateUploadContainer(bytes, filename);
    if (!validation.ok) throw new Error("UPLOAD_CONTAINER_INVALID");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

async function secureIntake(
  req: Request,
  res: Response,
  bufferAfterScan: boolean,
): Promise<boolean> {
  const file = req.file;
  if (!file?.path) return true;
  const userId = String(res.locals.userId ?? "unauthenticated");
  let projectId =
    (typeof req.params?.projectId === "string" && req.params.projectId) ||
    (typeof req.body?.project_id === "string" && req.body.project_id) ||
    null;
  const db = createServerSupabase();
  if (!projectId && typeof req.params?.documentId === "string") {
    const { data: document } = await db
      .from("documents")
      .select("project_id")
      .eq("id", req.params.documentId)
      .maybeSingle();
    projectId = document?.project_id ? String(document.project_id) : null;
  }
  try {
    await assertBetaDataPolicy(db, {
      userId,
      userEmail: res.locals.userEmail as string | undefined,
      projectId,
    });
  } catch (error) {
    await fsPromises.unlink(file.path).catch(() => undefined);
    if (error instanceof BetaPolicyError) {
      res.status(error.status).json({ code: error.code, detail: error.message });
      return false;
    }
    throw error;
  }
  const quarantineKey = quarantineStorageKey(userId, crypto.randomUUID());
  let intakeId: string | null = null;
  if (boolEnv("BETA_MODE") || boolEnv("UPLOAD_SCANNING_REQUIRED")) {
    const { data: intake, error: intakeError } = await db
      .from("upload_intakes")
      .insert({
        user_id: userId,
        project_id: projectId,
        quarantine_object_key: quarantineKey,
        byte_size: file.size,
        status: "scanning",
      })
      .select("id")
      .single();
    if (intakeError || !intake) {
      await fsPromises.unlink(file.path).catch(() => undefined);
      res.status(503).json({
        code: "UPLOAD_QUARANTINE_UNAVAILABLE",
        detail: "Secure upload quarantine is temporarily unavailable.",
      });
      return false;
    }
    intakeId = String(intake.id);
  }
  const markIntake = async (status: "clean" | "rejected", resultCode: string) => {
    if (!intakeId) return;
    await db
      .from("upload_intakes")
      .update({
        status,
        result_code: resultCode,
        completed_at: new Date().toISOString(),
      })
      .eq("id", intakeId);
  };
  let objectUploaded = false;
  const cleanup = async () => {
    await fsPromises.unlink(file.path).catch(() => undefined);
    if (objectUploaded) await deleteFile(quarantineKey).catch(() => undefined);
  };
  res.once("finish", () => void cleanup());
  res.once("close", () => void cleanup());

  try {
    await uploadFileStream(
      quarantineKey,
      fs.createReadStream(file.path),
      "application/octet-stream",
      file.size,
    );
    objectUploaded = true;
  } catch (error) {
    if (boolEnv("BETA_MODE") || boolEnv("UPLOAD_SCANNING_REQUIRED")) {
      await markIntake("rejected", "UPLOAD_QUARANTINE_UNAVAILABLE");
      await cleanup();
      res.status(503).json({
        code: "UPLOAD_QUARANTINE_UNAVAILABLE",
        detail: "Secure upload quarantine is temporarily unavailable.",
      });
      return false;
    }
  }

  if (intakeId) {
    const claimed = await claimWorkerLease(
      db,
      `upload-scan:${intakeId}`,
      workerInstanceId(),
      120,
    ).catch(() => false);
    if (!claimed) {
      await markIntake("rejected", "UPLOAD_SCAN_UNAVAILABLE");
      await cleanup();
      res.status(503).json({
        code: "UPLOAD_SCAN_UNAVAILABLE",
        detail: "Malware scanning is temporarily unavailable. No file was accepted.",
      });
      return false;
    }
  }
  const scan = await scanFileWithClamAv(file.path);
  if (scan.status === "infected") {
    await markIntake("rejected", "MALWARE_DETECTED");
    await cleanup();
    res.status(422).json({
      code: "UPLOAD_REJECTED",
      detail: "The upload was rejected by the malware scanner.",
    });
    return false;
  }
  if (
    scan.status === "unavailable" &&
    (boolEnv("BETA_MODE") || boolEnv("UPLOAD_SCANNING_REQUIRED"))
  ) {
    await markIntake("rejected", "UPLOAD_SCAN_UNAVAILABLE");
    await cleanup();
    res.status(503).json({
      code: "UPLOAD_SCAN_UNAVAILABLE",
      detail: "Malware scanning is temporarily unavailable. No file was accepted.",
    });
    return false;
  }

  // Existing conversion/extraction code consumes a Buffer. The network intake
  // and untrusted holding phase are streamed to disk/R2 first; bytes are loaded
  // only after the scan gate passes.
  if (bufferAfterScan) {
    file.buffer = await fsPromises.readFile(file.path);
  } else {
    const handle = await fsPromises.open(file.path, "r");
    try {
      const header = Buffer.alloc(64);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      file.buffer = header.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  const validation = await validateUploadContainer(file.buffer, file.originalname);
  if (!validation.ok) {
    await markIntake("rejected", "UPLOAD_CONTAINER_INVALID");
    await cleanup();
    res.status(422).json({ code: "UPLOAD_REJECTED", detail: validation.reason });
    return false;
  }
  if (objectUploaded) {
    await deleteFile(quarantineKey).catch(() => undefined);
    objectUploaded = false;
  }
  await markIntake("clean", "CLEAN");
  return true;
}

function fileUpload(
  fieldName: string,
  maxBytes: number,
  maxMb: number,
  bufferAfterScan = true,
): RequestHandler {
  const middleware = upload(maxBytes).single(fieldName);
  return (req, res, next) => {
    middleware(req, res, (error) => {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return void res.status(413).json({
            code: "UPLOAD_TOO_LARGE",
            detail: `File too large. Maximum size is ${maxMb} MB.`,
          });
        }
        return void res.status(400).json({ code: "UPLOAD_INVALID", detail: `Upload failed: ${error.message}` });
      }
      if (error) return next(error);
      void secureIntake(req, res, bufferAfterScan).then((ok) => {
        if (ok) next();
      }).catch(next);
    });
  };
}

export function singleFileUpload(fieldName: string): RequestHandler {
  return fileUpload(fieldName, MAX_UPLOAD_SIZE_BYTES, MAX_UPLOAD_SIZE_MB);
}

export function audioFileUpload(fieldName: string): RequestHandler {
  return fileUpload(
    fieldName,
    MAX_AUDIO_UPLOAD_SIZE_BYTES,
    MAX_AUDIO_UPLOAD_SIZE_MB,
    false,
  );
}
