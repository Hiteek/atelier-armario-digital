import { createServer, type ServerResponse } from 'node:http';

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
export function createRenderHttp(options: { authorize: (token: string) => Promise<string | null>; drain: (owner: string) => Promise<void> }) {
  let busy = false;
  return createServer({ maxHeaderSize: 8192, requestTimeout: 20000, headersTimeout: 10000 }, async (req, res) => {
    req.resume();
    if (req.method === 'GET' && req.url === '/healthz') { reply(res, 200, { ok: true }); return; }
    if (req.method !== 'POST' || req.url !== '/process') { reply(res, 404, { error: 'No encontrado.' }); return; }
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 5000) { reply(res, 401, { error: 'Sesión requerida.' }); return; }
    try {
      const owner = await options.authorize(authorization.slice(7));
      if (!owner) { reply(res, 403, { error: 'Cuenta no autorizada.' }); return; }
      if (busy) { reply(res, 202, { accepted: false, busy: true }); return; }
      busy = true;
      reply(res, 202, { accepted: true });
      // A normal user request starts a bounded batch. No artificial keep-alive traffic.
      void options.drain(owner).catch(() => console.error('El lote de procesamiento se interrumpió. La cola permanece guardada.')).finally(() => { busy = false; });
    } catch { reply(res, 503, { error: 'No se pudo comprobar la sesión.' }); }
  });
}
