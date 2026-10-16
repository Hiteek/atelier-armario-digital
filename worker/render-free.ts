import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { createJobRunner, type Work } from '../lib/job-runner';
import { createRenderHttp } from '../lib/render-http';
config({ path: '.env.local', quiet: true }); config({ quiet: true });
for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
  if (!process.env[name]) throw new Error(`Falta configurar ${name}.`);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
let stopping = false;
const server = createRenderHttp({
  async authorize(token) {
    const userDb = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false }
    });
    const user = await userDb.auth.getUser(token);
    if (user.error || !user.data.user) return null;
    const owner = await userDb.rpc('is_armario_owner');
    return !owner.error && owner.data === true ? user.data.user.id : null;
  },
  async drain(owner) {
    // Free services can sleep/restart: stop claiming with enough margin before the 15-minute idle window.
    const deadline = Date.now() + 10 * 60 * 1000;
    const run = createJobRunner(admin, () => {
      const remaining = deadline - Date.now() - 30000;
      if (remaining < 5000) throw new Error('Se agotó el tiempo del lote.');
      return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: Math.min(240000, remaining) });
    });
    while (!stopping && deadline - Date.now() > 300000) {
      const claimed = await admin.rpc('claim_job', { p_user: owner });
      if (claimed.error) throw new Error('No se pudo consultar la cola.');
      const job = claimed.data?.[0] as Work | undefined;
      if (!job) break;
      if (job.user_id !== owner) throw new Error('Propietario incorrecto.');
      await run(job);
    }
  }
});
server.listen(Number(process.env.PORT) || 10000, '0.0.0.0', () => console.log('Procesador Render Free listo. Los datos permanecen en Supabase.'));
process.on('SIGTERM', () => { stopping = true; server.close(); });
process.on('SIGINT', () => { stopping = true; server.close(); });
