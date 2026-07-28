import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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
