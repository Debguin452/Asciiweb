// Cloudflare Pages Function for WebRTC signaling
// Free tier: 100k requests/day, global edge deployment

interface Env {
  SIGNAL_KV: KVNamespace;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const roomId = url.searchParams.get('room');
  
  if (!roomId) {
    return new Response('Missing room parameter', { status: 400 });
  }
  
  try {
    const data = await request.json();
    
    // Store signaling data with 60s TTL
    await env.SIGNAL_KV.put(
      `signal:${roomId}`,
      JSON.stringify(data),
      { expirationTtl: 60 }
    );
    
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response('Invalid JSON', { status: 400 });
  }
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const roomId = url.searchParams.get('room');
  
  if (!roomId) {
    return new Response('Missing room parameter', { status: 400 });
  }
  
  const data = await env.SIGNAL_KV.get(`signal:${roomId}`);
  
  if (!data) {
    return new Response(JSON.stringify({ data: null }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Delete after reading (one-time use)
  await env.SIGNAL_KV.delete(`signal:${roomId}`);
  
  return new Response(data, {
    headers: { 'Content-Type': 'application/json' }
  });
};

// Handle CORS preflight
export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
};
