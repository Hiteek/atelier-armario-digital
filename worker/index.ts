import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { createJobRunner } from '../lib/job-runner';

config({ path: '.env.local', quiet: true });
config({ quiet: true });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[key]) throw new Error(`Falta configurar ${key} para iniciar el trabajador.`);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const run = createJobRunner(db, () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 240000 }));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
console.log('Trabajador local del armario iniciado. No se registran fotos ni secretos.');
async function loop() {
  while (!stopping) {
    try {
      const { data, error } = await db.rpc('claim_job');
      if (error) throw new Error('No se pudo consultar la cola');
      if (data?.[0]) { await run(data[0]); continue; }
    } catch { console.error('No se pudo consultar la cola. Se volverá a consultar sin repetir trabajos activos.'); }
    await new Promise(resolve => setTimeout(resolve, Math.max(1000, Number(process.env.WORKER_POLL_MS) || 3000)));
  }
}
void loop();
