import { auth } from '@clerk/nextjs/server';
import { listStyles } from '@/db/repositories/styles';
import { StyleConfigSchema } from '@/lib/styles';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const styles = await listStyles();
  return Response.json(
    styles.map((style) => {
      const parsed = StyleConfigSchema.safeParse(style.config);
      return {
        id: style.id,
        name: style.name,
        description: style.description,
        usesInspirationOverlay: parsed.success ? parsed.data.usesInspirationOverlay : false,
        usesFitInspoIntro: parsed.success ? parsed.data.usesFitInspoIntro : false,
      };
    })
  );
}
