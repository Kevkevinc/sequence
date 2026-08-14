/**
 * Allows the app to fetch a video's bytes from R2 in the browser.
 *
 * Saving a video now hands its bytes to the OS share sheet (see
 * `lib/saveVideo.ts`), which means the page has to `fetch()` the video from R2.
 * R2 is a different origin from the app, so that fetch is blocked unless the
 * bucket returns CORS headers permitting it. `<video>` and `<img>` never needed
 * this — the browser only enforces CORS on `fetch`/`XHR`.
 *
 * The read (`GET`/`HEAD`) access it grants is what downloads need; the same
 * rule also keeps the `PUT` the upload screen already relies on. It does NOT
 * make the bucket public: every object still requires a short-lived presigned
 * URL. CORS only decides whether *browser JavaScript* may read/write a response
 * it already holds a valid URL for.
 *
 * `PutBucketCors` REPLACES the whole policy — there is no merge — so this holds
 * the complete rule (upload + download), not just the download half. Editing
 * here must keep the `PUT`/`Content-Type` the upload screen needs, or uploading
 * new footage breaks.
 *
 * Run once (re-running is harmless — it writes the same policy):
 *   npm run set-r2-cors
 *
 * This needs an R2 token with bucket-settings ("Admin Read & Write")
 * permission. The app's normal object token cannot change bucket config and
 * will get AccessDenied — in that case set the same policy by hand in the
 * Cloudflare dashboard (R2 → the bucket → Settings → CORS policy), pasting the
 * JSON this script prints on failure.
 */
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { getRequiredEnv } from '../lib/env';

/**
 * The complete bucket policy, in the shape the Cloudflare dashboard's CORS
 * editor takes. One rule covers both directions:
 *  - `PUT` + `Content-Type`: the browser uploads clips straight to R2.
 *  - `GET`/`HEAD` + exposed headers: the browser fetches a finished video's
 *    bytes to hand to the OS share sheet.
 * Scoped to the app's real origins rather than `*` — no wildcard is needed
 * because these are the only places the app runs.
 */
const CORS_RULE = {
  AllowedOrigins: ['http://localhost:3000', 'https://sequence-black.vercel.app'],
  AllowedMethods: ['PUT', 'GET', 'HEAD'],
  AllowedHeaders: ['Content-Type'],
  ExposeHeaders: ['Content-Length', 'Content-Type'],
  MaxAgeSeconds: 3600,
};

async function main() {
  const bucket = getRequiredEnv('R2_BUCKET_NAME');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${getRequiredEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: getRequiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: getRequiredEnv('R2_SECRET_ACCESS_KEY'),
    },
  });

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: [CORS_RULE] },
    })
  );

  const check = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log(`CORS set on "${bucket}":`);
  console.log(JSON.stringify(check.CORSRules, null, 2));
}

main().catch((error) => {
  const denied = error?.Code === 'AccessDenied' || error?.$metadata?.httpStatusCode === 403;
  if (denied) {
    console.error(
      'AccessDenied: this R2 token cannot change bucket settings.\n' +
        'Set the CORS rule by hand instead: Cloudflare dashboard → R2 → your\n' +
        'bucket → Settings → CORS policy → Edit, and paste:\n'
    );
    console.error(JSON.stringify([CORS_RULE], null, 2));
  } else {
    console.error('Failed to set R2 CORS:', error);
  }
  process.exit(1);
});
