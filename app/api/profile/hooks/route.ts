import { auth } from '@clerk/nextjs/server';
import { createCreatorIfNotExists, updateCreatorProfile } from '@/db/repositories/creators';
import {
  CATALOG_HOOK_TEXTS,
  displayHookText,
  hookCatalogForAudience,
} from '@/lib/pipeline/hookLibrary';

/**
 * The hook library a creator browses in Settings.
 *
 * Kept off the main /api/profile route because it carries the whole catalogue,
 * narrowed to the creator's audience, alongside their current switched-off set —
 * a bigger, read-heavy payload the profile screen has no use for.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const creator = await createCreatorIfNotExists(userId);
  const categories = hookCatalogForAudience(creator.audience).map((category) => ({
    id: category.id,
    label: category.label,
    hooks: category.hooks.map((hook) => ({
      // The exact library text is the key the save and the director match on;
      // `display` is only ever shown.
      text: hook.text,
      display: displayHookText(hook.text),
    })),
  }));

  return Response.json({
    audience: creator.audience,
    disabledHooks: creator.disabledHooks ?? [],
    categories,
  });
}

export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  if (!Array.isArray(body.disabledHooks) || body.disabledHooks.some((h: unknown) => typeof h !== 'string')) {
    return Response.json({ error: 'disabledHooks must be an array of strings.' }, { status: 400 });
  }

  // Intersect with the known catalogue rather than trusting the client: only
  // real library lines are stored, so a stale or spoofed entry can never bloat
  // the row or slip past the director's exact-text match as a phantom. Duplicates
  // collapse in the same pass.
  const disabledHooks = [...new Set<string>(body.disabledHooks)].filter((h) =>
    CATALOG_HOOK_TEXTS.has(h)
  );

  await createCreatorIfNotExists(userId);
  const updated = await updateCreatorProfile(userId, { disabledHooks });
  if (!updated) return new Response('Creator not found', { status: 404 });

  return Response.json({ disabledHooks: updated.disabledHooks });
}
