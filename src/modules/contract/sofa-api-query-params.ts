/**
 * SofaScore query-string parameters captured in `Sofascore api documentation/`.
 * Paths are built in `SofaContractService`; **query params are not part of the path**
 * and must be appended for parity with the live site.
 */

/** `sofascore-news/{lang}/posts?page=&per_page=&categories=` */
export interface SofascoreNewsPostsQueryParams {
  page?: number;
  per_page?: number;
  categories?: string;
}

/**
 * Appends query parameters to a relative API path (or full URL).
 * Skips `undefined` and empty string values.
 */
export function appendQueryString(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    q.set(key, String(value));
  }
  const qs = q.toString();
  if (!qs) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${qs}`;
}
