import { auth } from '@clerk/nextjs/server';
import { createUploadUrl } from '@/lib/storage';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { errors: [{ field: 'form', message: 'Request body must be valid JSON.' }] },
      { status: 400 }
    );
  }

  const errors: { field: string; message: string }[] = [];

  if (typeof body?.filename !== 'string' || !body.filename.trim()) {
    errors.push({ field: 'filename', message: 'Filename is required.' });
  }
  if (typeof body?.contentType !== 'string' || !body.contentType.trim()) {
    errors.push({ field: 'contentType', message: 'Content type is required.' });
  }

  if (errors.length > 0) {
    return Response.json({ errors }, { status: 400 });
  }

  const result = await createUploadUrl(body.filename.trim(), body.contentType.trim());
  return Response.json(result);
}
