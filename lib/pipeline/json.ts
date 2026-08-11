/**
 * Pulls the first complete JSON value out of a model response.
 *
 * `JSON.parse` on the raw text is correct only when the model returns exactly
 * one value and nothing else. In practice it does not always: a live job failed
 * three attempts in a row on "Unexpected non-whitespace character after JSON at
 * position 12384", which is `JSON.parse` reporting that it read a perfectly good
 * object and then found more text behind it. The plan was there and usable; the
 * trailing characters threw it away.
 *
 * Scanning for the first balanced value handles that, and the other shapes that
 * arrive with it — a ```json fence, a sentence of preamble, a second object the
 * model started and abandoned. It cannot rescue a genuinely truncated response,
 * which is correct: that one is caught earlier by the MAX_TOKENS check, and
 * inventing a closing brace would turn a short plan into a silently wrong one.
 */
export function parseFirstJsonValue(text: string): unknown {
  // The overwhelmingly common case, and the only one that needs no scanning.
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the scan below.
  }

  const start = text.search(/[{[]/);
  if (start === -1) throw new SyntaxError('The response contained no JSON value');

  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    // Braces inside a string are text, not structure — a hook containing "{"
    // would otherwise throw the depth count off and truncate the value.
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) {
        // Parsed rather than returned raw: a balanced span can still be
        // invalid JSON, and the caller is owed a real error in that case.
        return JSON.parse(text.slice(start, index + 1));
      }
    }
  }

  throw new SyntaxError('The response contained no complete JSON value');
}
