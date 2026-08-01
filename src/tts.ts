export function validateTerm(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (t.length > 200) return null;
  if (!/^[A-Za-z0-9 \-'.?,!]+$/.test(t)) return null;
  return t.toLowerCase();
}

export function cacheKey(lang: string, providerName: string, term: string): string {
  return `audio:${lang}:${providerName}:${term}`;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch] as string));
}
