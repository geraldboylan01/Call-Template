/**
 * Whether a fetched page is the page a link promised. Pure: the script that
 * fetches (`scripts/check-figure-links.mjs`) hands each response here, so the
 * judgement can be tested without a network.
 *
 * Two things make "it answered" a poor test. Revenue answers a page that does
 * not exist with a normal 200 and a message in the page, so the body has to be
 * read. And gov.ie and Citizens Information refuse scripted requests with a 403
 * even for pages that exist, so a refusal from them proves nothing either way:
 * it is reported as unverified, to be opened in a browser, never as a pass.
 */

/** Hosts that answer a scripted request with a refusal, whatever the page. */
export const HOSTS_THAT_REFUSE_SCRIPTS = Object.freeze(['www.gov.ie', 'gov.ie', 'www.citizensinformation.ie', 'citizensinformation.ie']);

/**
 * What a "no such page" answer looks like when its status says ok. Revenue's own
 * wording is in the body; a site's usual 404 page says so in its title. The body
 * is not searched for "not found" generally: a large page can carry another
 * page's "Page Not Found" metadata in its scripts and still be the right page.
 */
const NOT_FOUND_BODY = /the page you are looking for has been removed/i;
const NOT_FOUND_TITLE = /\b404\b|not found|cannot be found|can.t be found/i;

/**
 * @param {{ status: number, host: string, body?: string, error?: string }} response
 * @returns {{ result: 'ok' | 'broken' | 'refused', reason: string }}
 */
export function classifyLinkResponse({ status, host, body = '', error = '' }) {
  if (error) return { result: 'broken', reason: error };
  if (status === 403 || status === 429) {
    return HOSTS_THAT_REFUSE_SCRIPTS.includes(host)
      ? { result: 'refused', reason: `${host} refuses scripted requests (${status}); open it in a browser` }
      : { result: 'broken', reason: `refused with ${status}` };
  }
  if (status === 404 || status === 410) return { result: 'broken', reason: `no such page (${status})` };
  if (status >= 500) return { result: 'broken', reason: `server error (${status})` };
  if (status < 200 || status >= 300) return { result: 'broken', reason: `unexpected status ${status}` };
  const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '';
  if (NOT_FOUND_BODY.test(body) || NOT_FOUND_TITLE.test(title)) {
    return { result: 'broken', reason: 'the page says it is not found, though the status was ok' };
  }
  return { result: 'ok', reason: `answered ${status}` };
}
