// Counts Murshid downloads and update checks for the WebBrain stats dashboard
// (https://api.webbrain.one/stats/murshid). Vercel still serves every file from
// its CDN: this only reports the request, after handing it on, and reports
// nothing unless MURSHID_DOWNLOAD_EVENT_SECRET is set for the project.
//
// The receiving server decides what counts (installers, macOS update archives,
// update checks) and keeps the address only as a salted hash.

declare const process: { env: Record<string, string | undefined> };

type RequestContext = { waitUntil: (promise: Promise<unknown>) => void };

export const config = {
  matcher: ['/download/:path*', '/updates/stable.json'],
};

const DEFAULT_ENDPOINT = 'https://api.webbrain.one/v1/murshid/downloads';

export default function middleware(request: Request, context?: RequestContext): undefined {
  const secret = process.env.MURSHID_DOWNLOAD_EVENT_SECRET;
  if (!secret || !context || request.method !== 'GET') return undefined;

  // Download managers and resumed downloads fetch the rest of a file in more
  // requests; only a request from the first byte is a download.
  const range = request.headers.get('range') || '';
  if (range && !/^bytes\s*=\s*0-/i.test(range.trim())) return undefined;

  const headers = request.headers;
  let referrerHost = '';
  try {
    referrerHost = new URL(headers.get('referer') || '').hostname;
  } catch {
    referrerHost = '';
  }
  const event = {
    path: new URL(request.url).pathname,
    method: request.method,
    range,
    ip: headers.get('x-real-ip') || (headers.get('x-forwarded-for') || '').split(',')[0].trim(),
    country: headers.get('x-vercel-ip-country') || '',
    user_agent: (headers.get('user-agent') || '').slice(0, 300),
    referrer_host: referrerHost,
  };

  context.waitUntil(
    fetch(process.env.MURSHID_DOWNLOAD_EVENT_URL || DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined),
  );
  // Returning nothing hands the request on to the static file.
  return undefined;
}
