import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getRequiredEnv } from '@/lib/env';

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${getRequiredEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: getRequiredEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: getRequiredEnv('R2_SECRET_ACCESS_KEY'),
  },
});

export async function createUploadUrl(originalFilename: string, contentType: string) {
  const storageKey = `clips/${randomUUID()}-${originalFilename}`;
  const command = new PutObjectCommand({
    Bucket: getRequiredEnv('R2_BUCKET_NAME'),
    Key: storageKey,
    ContentType: contentType,
  });
  const url = await getSignedUrl(client, command, { expiresIn: 300 });
  return { url, storageKey };
}

export async function getClipBuffer(storageKey: string): Promise<{ buffer: Buffer; contentType: string }> {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: getRequiredEnv('R2_BUCKET_NAME'),
      Key: storageKey,
    })
  );

  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    buffer: Buffer.concat(chunks),
    contentType: result.ContentType ?? 'application/octet-stream',
  };
}
