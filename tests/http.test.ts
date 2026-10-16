import { describe, expect, it } from 'vitest';
import { limitedBody, readJson, requestKey, sameOrigin } from '../lib/http';
describe('Protección de rutas', () => {
  it('rechaza mutaciones desde orígenes ajenos o sin Origin', () => {
    expect(() => sameOrigin(new Request('http://127.0.0.1:3000/api/render', { headers: { Origin: 'https://otro.test' } }))).toThrow();
    expect(() => sameOrigin(new Request('http://127.0.0.1:3000/api/render'))).toThrow();
    expect(() => sameOrigin(new Request('http://127.0.0.1:3000/api/render', { headers: { Origin: 'http://127.0.0.1:3000' } }))).not.toThrow();
  });
  it('limita datos transmitidos incluso cuando no hay Content-Length', async () => {
    const request = new Request('http://127.0.0.1:3000/api/upload', { method: 'POST', body: 'abcdef' });
    await expect(limitedBody(request, 5)).rejects.toThrow(/demasiado grande/);
  });
  it('valida JSON y exige una clave de intento UUID', async () => {
    await expect(readJson(new Request('http://127.0.0.1:3000/api/render', { method: 'POST', body: '{' }))).rejects.toThrow(/formato válido/);
    expect(() => requestKey(new Request('http://127.0.0.1:3000/api/render'))).toThrow();
  });
});
