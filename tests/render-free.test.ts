import { describe, expect, it, vi } from 'vitest';
import { createRenderHttp } from '../lib/render-http';
import { renderEndpoint } from '../lib/render-gateway';

describe('Pasarela a Render', () => {
  it('solo transmite sesiones al origen HTTPS autorizado onrender.com', () => {
    expect(renderEndpoint('https://atelier-test.onrender.com')).toBe('https://atelier-test.onrender.com/process');
    for (const value of ['http://atelier-test.onrender.com', 'https://atelier-test.onrender.com.evil.test', 'https://evil.test', 'https://key@atelier-test.onrender.com', 'https://atelier-test.onrender.com/redirect', 'https://atelier-test.onrender.com?next=evil']) expect(() => renderEndpoint(value)).toThrow();
  });
  it('protege el procesamiento con sesión de propietario y evita dos lotes simultáneos', async () => {
    let finish!: () => void;
    const deferred = new Promise<void>(resolve => { finish = resolve; });
    const authorize = vi.fn(async (token: string) => token === 'owner-session' ? 'owner' : null);
    const drain = vi.fn(async () => deferred);
    const server = createRenderHttp({ authorize, drain });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/process`, { method: 'POST' })).status).toBe(401);
      expect((await fetch(`${base}/process`, { method: 'POST', headers: { Authorization: 'Bearer stranger' } })).status).toBe(403);
      const request = () => fetch(`${base}/process`, { method: 'POST', headers: { Authorization: 'Bearer owner-session' } });
      expect(await (await request()).json()).toEqual({ accepted: true });
      expect(await (await request()).json()).toEqual({ accepted: false, busy: true });
      expect(drain).toHaveBeenCalledTimes(1);
    } finally { finish(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
