import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isConfigured, sessionClient } from './supabase';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store, private' } });
}
export async function authenticated() {
  if (!isConfigured()) throw new HttpError(503, 'Falta conectar el almacenamiento privado.');
  const db = await sessionClient();
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) throw new HttpError(401, 'Inicia sesión para abrir tu armario.');
  const owner = await db.rpc('is_armario_owner');
  if (owner.error || !owner.data) throw new HttpError(403, 'Este armario es privado y está reservado a su propietario.');
  return { db, user };
}
export function sameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  const allowed = new URL(process.env.APP_URL || 'http://127.0.0.1:3000').origin;
  if (!origin || origin !== allowed) throw new HttpError(403, 'Solicitud desde un origen no autorizado.');
}
export function dbCheck(error: { message: string } | null) {
  if (!error) return;
  if (error.message.includes('MONTHLY_LIMIT')) throw new HttpError(429, 'Llegaste al límite mensual de imágenes. Puedes ajustarlo en tu perfil.');
  if (error.message.includes('QUEUE_FULL')) throw new HttpError(429, 'Hay muchas fotos en proceso. Espera un momento antes de subir más.');
  if (error.message.includes('NOT_FOUND')) throw new HttpError(404, 'No se encontró ese elemento.');
  throw new HttpError(503, 'No se pudo guardar la operación. Inténtalo de nuevo más tarde.');
}
export async function limitedBody(req: Request, max: number) {
  if (Number(req.headers.get('content-length') || 0) > max) throw new HttpError(413, 'El archivo o la solicitud es demasiado grande.');
  if (!req.body) throw new HttpError(400, 'La solicitud está vacía.');
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new HttpError(413, 'El archivo o la solicitud es demasiado grande.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJson(req: Request) {
  try { return JSON.parse((await limitedBody(req, 16 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'La solicitud no tiene un formato válido.'); }
}
export function requestKey(req: Request) { return z.string().uuid().parse(req.headers.get('idempotency-key')); }
export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return json({ error: 'Revisa los campos: ' + error.issues.map(i => i.path.join('.')).join(', ') }, 400);
  // Do not return provider errors, SQL text, credentials or stack traces to the browser.
  console.error('Armario request failed:', error instanceof Error ? error.name : 'unknown');
  return json({ error: 'No se pudo completar la operación. Inténtalo más tarde.' }, 500);
}
