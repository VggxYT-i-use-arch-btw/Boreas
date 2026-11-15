/** The single fetch boundary used by the page and the background worker. */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}
