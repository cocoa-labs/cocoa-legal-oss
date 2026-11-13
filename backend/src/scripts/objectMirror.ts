import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { installStructuredConsole } from "../lib/logger";

installStructuredConsole();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function client(prefix: "R2" | "BACKUP_S3"): S3Client {
  return new S3Client({ region: process.env[`${prefix}_REGION`] ?? "auto", endpoint: required(`${prefix}_ENDPOINT_URL`), forcePathStyle: true, credentials: { accessKeyId: required(`${prefix}_ACCESS_KEY_ID`), secretAccessKey: required(`${prefix}_SECRET_ACCESS_KEY`) } });
}

async function main() {
 const source = client("R2");
 const destination = client("BACKUP_S3");
 const sourceBucket = required("R2_BUCKET_NAME");
 const destinationBucket = required("BACKUP_S3_BUCKET");
 let continuationToken: string | undefined;
 let mirrored = 0;
 do {
  const page = await source.send(new ListObjectsV2Command({ Bucket: sourceBucket, ContinuationToken: continuationToken }));
  for (const object of page.Contents ?? []) {
    if (!object.Key) continue;
    const destinationKey = `objects/${object.Key}`;
    const sourceEtag = (object.ETag ?? "").replaceAll('"', "");
    try {
      const existing = await destination.send(new HeadObjectCommand({ Bucket: destinationBucket, Key: destinationKey }));
      if (existing.Metadata?.sourceetag === sourceEtag && Number(existing.ContentLength ?? -1) === Number(object.Size ?? -2)) continue;
    } catch {
      // Missing destination object: copy it below.
    }
    const body = await source.send(new GetObjectCommand({ Bucket: sourceBucket, Key: object.Key }));
    if (!body.Body) throw new Error("Source object body unavailable");
    await destination.send(new PutObjectCommand({ Bucket: destinationBucket, Key: destinationKey, Body: body.Body, ContentLength: object.Size, ServerSideEncryption: "AES256", Metadata: { sourceetag: sourceEtag } }));
    mirrored += 1;
  }
  continuationToken = page.NextContinuationToken;
 } while (continuationToken);
 console.info("Object mirror completed", { count: mirrored });
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
