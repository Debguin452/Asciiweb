interface Env { ROOMS_KV: KVNamespace; }

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function code(params: Params): string {
  const raw = Array.isArray(params.code) ? params.code[0] : params.code ?? "";
  return (raw as string).toUpperCase();
}

async function getPeers(kv: KVNamespace, c: string): Promise<string[]> {
  const raw = await kv.get(`room:${c}`);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}

async function setPeers(kv: KVNamespace, c: string, peers: string[]): Promise<void> {
  await kv.put(`room:${c}`, JSON.stringify(peers), { expirationTtl: 14400 });
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { headers: CORS });

export const onRequestGet: PagesFunction<Env> = async ({ params, env }) => {
  const c = code(params);
  if (!c) return json({ error: "code required" }, 400);
  const peers = await getPeers(env.ROOMS_KV, c);
  return json({ code: c, peers });
};

export const onRequestPut: PagesFunction<Env> = async ({ request, params, env }) => {
  const c = code(params);
  const body = await request.json().catch(() => null) as { peerId?: string; replace?: string } | null;
  const peerId = body?.peerId;
  if (!c || !peerId) return json({ error: "code and peerId required" }, 400);

  let peers = await getPeers(env.ROOMS_KV, c);
  if (peers.length === 0) return json({ error: "Room not found" }, 404);

  if (body?.replace && peers.includes(body.replace)) {
    // Peer reconnected with a fresh signaling ID (e.g. after a network drop
    // forced PeerJS to re-register) — swap it in place so the other side's
    // next reconnect attempt resolves to the live ID.
    peers = peers.map(p => (p === body.replace ? peerId : p));
  } else if (!peers.includes(peerId)) {
    peers.push(peerId);
  }

  await setPeers(env.ROOMS_KV, c, peers);
  return json({ code: c, peers });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, params, env }) => {
  const c = code(params);
  const body = await request.json().catch(() => null) as { peerId?: string } | null;
  const peerId = body?.peerId;
  if (!c) return json({ error: "code required" }, 400);
  const peers = await getPeers(env.ROOMS_KV, c);
  const filtered = peerId ? peers.filter(p => p !== peerId) : [];
  if (filtered.length === 0) await env.ROOMS_KV.delete(`room:${c}`);
  else await setPeers(env.ROOMS_KV, c, filtered);
  return json({ ok: true });
};
