// Longest cause detail we fold into a returned error string. Zod reports every
// failing field, which for a large malformed response would otherwise flood the
// job's failure_reason column.
export const MAX_CAUSE_LENGTH = 300;

/**
 * Collapses an unknown thrown value into a single-line, length-capped string
 * suitable for a stored failure reason or a prompt correction note.
 */
export function describeCause(error: unknown, maxLength: number = MAX_CAUSE_LENGTH): string {
  const message = error instanceof Error ? error.message : String(error);
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}...` : collapsed;
}
