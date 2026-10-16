import { authenticated, dbCheck, errorResponse, HttpError, json, sameOrigin } from '@/lib/http';
import { renderEndpoint } from '@/lib/render-gateway';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Forward only the verified owner's short-lived session to the configured Render service.
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const { db } = await authenticated();
    if (!process.env.RENDER_PROCESSOR_URL) throw new HttpError(503, 'Falta conectar el procesador gratuito del armario.');
    const session = await db.auth.getSession(); dbCheck(session.error);
    const token = session.data.session?.access_token;
    if (!token) throw new HttpError(401, 'Inicia sesión de nuevo.');
    const response = await fetch(renderEndpoint(process.env.RENDER_PROCESSOR_URL), {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(90000), cache: 'no-store'
    });
    if (response.status !== 202) throw new HttpError(503, 'El procesador no está disponible. Espera mientras se inicia y vuelve a intentarlo.');
    const result = await response.json();
    return json({ accepted: result.accepted === true, busy: result.busy === true }, 202);
  } catch (error) { return errorResponse(error); }
}
