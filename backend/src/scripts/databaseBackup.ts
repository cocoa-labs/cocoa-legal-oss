import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { installStructuredConsole } from "../lib/logger";

installStructuredConsole();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function main() {
 const work = await mkdtemp(path.join(os.tmpdir(), "coco-backup-"));
 try {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const dump = path.join(work, "database.dump");
  const encrypted = `${dump}.age`;
  await run("pg_dump", ["--dbname", required("DATABASE_URL"), "--format=custom", "--no-owner", "--file", dump]);
  await run("age", ["--recipient", required("BACKUP_AGE_RECIPIENT"), "--output", encrypted, dump]);
  const client = new S3Client({
    region: process.env.BACKUP_S3_REGION ?? "auto",
    endpoint: required("BACKUP_S3_ENDPOINT_URL"),
    forcePathStyle: true,
    credentials: { accessKeyId: required("BACKUP_S3_ACCESS_KEY_ID"), secretAccessKey: required("BACKUP_S3_SECRET_ACCESS_KEY") },
  });
  const key = `database/${timestamp}.dump.age`;
  const info = await stat(encrypted);
  await client.send(new PutObjectCommand({ Bucket: required("BACKUP_S3_BUCKET"), Key: key, Body: createReadStream(encrypted), ContentLength: info.size, ContentType: "application/octet-stream", ServerSideEncryption: "AES256" }));
  console.info("Encrypted database backup uploaded", { count: 1 });
 } finally {
   await rm(work, { recursive: true, force: true });
 }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
