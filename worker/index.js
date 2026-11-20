// Cloudflare Worker for appliedailetter.com. Runs first for every request (see wrangler.jsonc).
//   www host            -> 301 to the apex
//   POST /api/cancel    -> rate-limited proxy to the cancel API, with a shared-secret header
//   GET|HEAD /subscribe -> 302 to the Stripe Payment Link (secret SUBSCRIBE_URL)
//   anything else       -> the static site in public/
// The upstream values are Worker secrets (CANCEL_API_URL, CANCEL_SHARED_SECRET, SUBSCRIBE_URL); none is in this repo.

const APEX = 'appliedailetter.com';

const json = (status, body, extra) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });

async function cancel(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'support' }, { allow: 'POST' });

  const key = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.CANCEL_LIMITER.limit({ key });
  if (!success) return json(429, { error: 'support' });

  if (!env.CANCEL_API_URL || !env.CANCEL_SHARED_SECRET) return json(503, { error: 'support' });

  try {
    const upstream = await fetch(env.CANCEL_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Cancel-Secret': env.CANCEL_SHARED_SECRET },
      body: await request.text(),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return json(502, { error: 'support' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === `www.${APEX}`) {
      return Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301);
    }

    if (url.pathname === '/api/cancel') return cancel(request, env);

    if (url.pathname === '/subscribe' && (request.method === 'GET' || request.method === 'HEAD')) {
      try {
        return Response.redirect(env.SUBSCRIBE_URL || new URL('/', url).href, 302);
      } catch {
        return Response.redirect(new URL('/', url).href, 302); // malformed SUBSCRIBE_URL secret
      }
    }

    return env.ASSETS.fetch(request);
  },
};
