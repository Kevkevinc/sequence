import { auth } from '@clerk/nextjs/server';
import { createUploadUrl } from '@/lib/storage';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const { filename, contentType } = await req.json();
  const result = await createUploadUrl(filename, contentType);
  return Response.json(result);
}
