'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Heart, Home, ImagePlus, LoaderCircle, LockKeyhole, LogOut, Plus, Search, Shirt, Sparkles, Trash2, Upload, UserRound, X } from 'lucide-react';
import { CATEGORIES, OCCASIONS, categoryLabels, occasionLabels } from '@/lib/catalog';
import type { AgendaEvent, Garment, Outfit, Profile, Snapshot } from '@/lib/domain';
import ClosetArt from './closet-art';

type Tab = 'inicio' | 'armario' | 'ideas' | 'semana' | 'perfil';
const tabs = [{ id: 'inicio', label: 'Mi espacio', icon: Home }, { id: 'armario', label: 'Mi armario', icon: Shirt }, { id: 'ideas', label: 'Ideas de looks', icon: Sparkles }, { id: 'semana', label: 'Mi semana', icon: CalendarDays }, { id: 'perfil', label: 'Mi perfil', icon: UserRound }] as const;
const titles = { inicio: 'Mi espacio', armario: 'Mi armario', ideas: 'Ideas de looks', semana: 'Mi semana', perfil: 'Mi perfil' };
const emptyProfile: Profile = { user_id: '', display_name: 'Mi armario', styles: [], favorite_colors: [], work_formality: 3, monthly_image_limit: 30, photo_path: null, photo_version: 0 };
const empty: Snapshot = { profile: emptyProfile, garments: [], outfits: [], events: [], jobs: [], simulations: [], image_requests: 0, pending_jobs: 0 };
const statusLabels: Record<string, string> = { queued: 'En espera', running: 'Procesando', succeeded: 'Completado', failed: 'No completado', uncertain: 'Resultado incierto', cancelled: 'Cancelado', processing: 'Analizando', review: 'Por confirmar', ready: 'Lista', error: 'Revisión manual' };
const kindLabels: Record<string, string> = { analyze: 'Clasificar prenda', suggest: 'Proponer conjuntos', render: 'Crear simulación', cleanup: 'Eliminar fotos del almacenamiento' };
const todayLima = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Lima' }).format(new Date());
function weekDates(anchor: string) {
  const d = new Date(`${anchor}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, i) => { const day = new Date(d); day.setUTCDate(d.getUTCDate() + i); return day.toISOString().slice(0, 10); });
}
async function api<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  const res = await fetch(`/api/${path}`, { method, headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), cache: 'no-store' });
  const data = await res.json(); if (!res.ok) throw Object.assign(new Error(data.error || 'No se pudo completar la operación.'), { status: res.status }); return data;
}
async function uploadPhoto(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size) throw new Error('Elige una foto JPG, PNG o WebP de hasta 10 MB.');
  // Resize before transport to stay below Vercel's request limit; browser applies EXIF orientation.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); throw new Error('La resolución es demasiado grande. Usa una foto de hasta 40 megapíxeles.'); }
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d'); if (!context) { bitmap.close(); throw new Error('No se pudo preparar la foto.'); }
  context.fillStyle = '#f6f3ee'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('No se pudo preparar la foto.')), 'image/jpeg', .88));
  if (blob.size > 3 * 1024 * 1024) throw new Error('Esta foto requiere reducir su resolución antes de subirla.');
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

export default function WardrobeApp() {
  const [tab, setTab] = useState<Tab>('inicio'); const [data, setData] = useState<Snapshot>(empty);
  const [configured, setConfigured] = useState<boolean | null>(null); const [loggedIn, setLoggedIn] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false); const [busy, setBusy] = useState(''); const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const [editing, setEditing] = useState<Garment | null>(null); const [selected, setSelected] = useState<Outfit | null>(null);
  const [eventEditor, setEventEditor] = useState<Partial<AgendaEvent> | null>(null); const [eventTarget, setEventTarget] = useState<AgendaEvent | null>(null);
  const [week, setWeek] = useState(todayLima()); const [search, setSearch] = useState(''); const [category, setCategory] = useState(''); const [filterStatus, setFilterStatus] = useState('');
  const [occasion, setOccasion] = useState<typeof OCCASIONS[number]>('trabajo'); const [notes, setNotes] = useState(''); const [suggestionJob, setSuggestionJob] = useState<string | null>(null);
  const [latestIds, setLatestIds] = useState<string[] | null>(null); const [favoritesOnly, setFavoritesOnly] = useState(false);
  const pumping = useRef(false);
  const nextKick = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null); const profileFileRef = useRef<HTMLInputElement>(null); const pending = useRef(false);
  const refresh = useCallback(async () => {
    try { const d = await api<Snapshot>('snapshot'); setData(d); setLoggedIn(true); return d; }
    catch (e) { if ((e as { status: number }).status === 401) { setLoggedIn(false); setData(empty); } else throw e; }
  }, []);
  useEffect(() => { void api<{ configured: boolean }>('status').then(async s => { setConfigured(s.configured); if (s.configured) await refresh(); }).catch(e => setError(e.message)); }, [refresh]);
  useEffect(() => {
    if (!loggedIn) return;
    const timer = setInterval(() => { void refresh().catch(e => setError(e.message)); }, data.pending_jobs > 0 ? 5000 : 60000);
    return () => clearInterval(timer);
  }, [loggedIn, data.jobs, refresh]);
  useEffect(() => {
    if (!loggedIn || pumping.current || data.pending_jobs === 0 || Date.now() < nextKick.current) return;
    pumping.current = true;
    nextKick.current = Date.now() + 45000;
    void api('process', 'POST', {}).then(() => refresh()).catch(e => setError(e.message)).finally(() => { pumping.current = false; });
  }, [loggedIn, data.jobs, refresh]);
  useEffect(() => {
    if (!suggestionJob) return;
    const job = data.jobs.find(j => j.id === suggestionJob);
    if (job?.status === 'succeeded' && Array.isArray(job.result?.outfit_ids)) {
      setLatestIds(job.result!.outfit_ids as string[]); setSuggestionJob(null); setNotice('Tus propuestas están listas. Elige la que más te guste.');
    } else if (job && ['failed', 'cancelled'].includes(job.status)) { setError(job.error || 'No se pudieron crear las propuestas.'); setSuggestionJob(null); }
  }, [data.jobs, suggestionJob]);
  async function act(label: string, fn: () => Promise<void>) {
    if (pending.current) return; pending.current = true; setBusy(label); setError(''); setNotice('');
    try { await fn(); if (loggedIn) await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); pending.current = false; }
  }
  function ready() { if (!configured) { setError('El armario aún necesita conectar su almacenamiento privado. Consulta la guía de puesta en marcha.'); return false; } if (!loggedIn) { setLoginOpen(true); return false; } return true; }
  async function upload(files: FileList | null, kind: 'garment' | 'profile') {
    if (!files?.length || !ready()) return;
    await act('Preparando fotos…', async () => {
      const failures: string[] = [];
      for (const [i, original] of Array.from(files).entries()) {
        setBusy(`Subiendo ${i + 1} de ${files.length}…`);
        try {
          const file = await uploadPhoto(original); const form = new FormData(); form.set('kind', kind); form.set('file', file);
          await api('upload', 'POST', form, crypto.randomUUID());
        } catch (e) { failures.push(`${original.name}: ${(e as Error).message}`); }
      }
      setNotice(kind === 'profile' ? 'Foto de perfil actualizada.' : 'Fotos recibidas. Confirma la clasificación cuando termine el análisis.');
      if (failures.length) throw new Error(failures.join(' · '));
    });
    if (fileRef.current) fileRef.current.value = ''; if (profileFileRef.current) profileFileRef.current.value = '';
  }
  async function suggest() {
    if (!ready()) return;
    await act('Buscando combinaciones…', async () => {
      const r = await api<{ job: { id: string } }>('suggestions', 'POST', { occasion, notes }, crypto.randomUUID());
      setSuggestionJob(r.job.id); setLatestIds(null); setNotice('Tu estilista está preparando las propuestas. Puedes seguir explorando tu armario.');
    });
  }
  const dates = weekDates(week); const confirmed = data.garments.filter(g => g.status === 'ready');
  const currentOutfits = data.outfits.filter(o => (!latestIds || latestIds.includes(o.id)) && (!favoritesOnly || o.favorite));
  const filtered = data.garments.filter(g => (!category || g.category === category) && (!filterStatus || g.status === filterStatus) && `${g.name} ${g.colors.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const navigate = (value: Tab) => { setTab(value); setError(''); setNotice(''); };
  function openForEvent(event: AgendaEvent) { setOccasion(event.occasion); setNotes(event.notes); setEventTarget(event); setLatestIds(null); setTab('ideas'); }
  async function selectForEvent(outfit: Outfit) {
    if (!eventTarget) return;
    await act('Guardando conjunto…', async () => { await api(`events/${eventTarget.id}`, 'PATCH', { date: eventTarget.date, occasion: eventTarget.occasion, notes: eventTarget.notes, outfit_id: outfit.id }); setEventTarget(null); setTab('semana'); setNotice('Conjunto guardado en tu semana.'); });
  }
  function outfitCard(o: Outfit) {
    const available = o.garment_ids.every(id => data.garments.some(g => g.id === id && g.available && g.status === 'ready'));
    return <article className="look-card" key={o.id}>
      <button className="look-collage" onClick={() => setSelected(o)} aria-label={`Abrir ${o.title}`}>
        {o.garment_ids.map(id => { const g = data.garments.find(g => g.id === id); return g ? <img key={id} src={g.thumbnail_url} alt={g.name}/> : <span key={id} className="missing-piece">Prenda retirada</span>; })}
      </button>
      <div className="look-body"><div className="row"><span className="eyebrow">{occasionLabels[o.occasion]}</span><button className={`icon-button ${o.favorite ? 'liked' : ''}`} aria-label={o.favorite ? 'Quitar de favoritos' : 'Guardar en favoritos'} onClick={() => { if (ready()) void act('Guardando…', async () => { await api(`outfits/${o.id}`, 'PATCH', { favorite: !o.favorite }); }); }}><Heart size={19} fill={o.favorite ? 'currentColor' : 'none'}/></button></div>
        <h3>{o.title}</h3><p>{o.explanation}</p>{o.missing.length > 0 && <p className="warning">Falta: {o.missing.join(', ')}</p>}{!available && <p className="warning">Hay prendas retiradas o no disponibles.</p>}
        <button className="button secondary full" onClick={() => eventTarget ? void selectForEvent(o) : setSelected(o)} disabled={!!busy || !available}>{eventTarget ? 'Elegir para este día' : 'Explorar este look'}<ArrowRight size={16}/></button>
      </div></article>;
  }
  return <div className="app-shell">
    <aside className="sidebar"><button className="brand" onClick={() => navigate('inicio')}>atelier<span>MI ARMARIO DIGITAL</span></button><div className="sidebar-label">TU ESPACIO PERSONAL</div><nav aria-label="Navegación principal">{tabs.map(t => <button key={t.id} aria-label={t.label} aria-current={tab === t.id ? 'page' : undefined} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => navigate(t.id)}><t.icon size={20}/><span>{t.label}</span>{t.id === 'armario' && <small>{data.garments.length}</small>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="private-note"><LockKeyhole size={18}/><div><strong>Solo para ti</strong><p>Tu ropa. Tu estilo. Tu espacio.</p></div></div><button className="account" onClick={() => loggedIn ? navigate('perfil') : setLoginOpen(true)}><span className="avatar">{loggedIn ? data.profile.display_name[0]?.toUpperCase() : <UserRound size={20}/>}</span><span><strong>{loggedIn ? data.profile.display_name : 'Tu armario personal'}</strong><small>{loggedIn ? 'Ver mi perfil' : 'Iniciar sesión'}</small></span>{loggedIn && <ChevronRight size={16}/>}</button></div>
    </aside>
    <main className="main"><header className="topbar"><span>{titles[tab]}</span><div className="topbar-right"><span className="private-pill"><LockKeyhole size={12}/> Privado</span>{loggedIn && <button className="icon-button" aria-label="Cerrar sesión" onClick={() => void act('Cerrando sesión…', async () => { await api('logout', 'POST', {}); setLoggedIn(false); setData(empty); })}><LogOut size={18}/></button>}</div></header>
      <div className="content">
        {configured === false && <div className="setup-banner"><LockKeyhole size={17}/><span><strong>Vista previa de tu armario.</strong> Falta conectar Supabase para guardar tus fotos y activar el estilista.</span></div>}
        {configured && !loggedIn && <div className="setup-banner"><LockKeyhole size={17}/><span>Inicia sesión para abrir tu armario privado.</span><button onClick={() => setLoginOpen(true)}>Entrar <ArrowRight size={14}/></button></div>}
        {(notice || error) && <div className={`message ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button className="icon-button" aria-label="Cerrar mensaje" onClick={() => { setNotice(''); setError(''); }}><X size={16}/></button></div>}
        {busy && <div className="working" role="status"><LoaderCircle className="spin" size={16}/>{busy}</div>}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="visually-hidden" aria-label="Subir fotos de prendas" onChange={e => void upload(e.target.files, 'garment')}/>
        <input ref={profileFileRef} type="file" accept="image/jpeg,image/png,image/webp" className="visually-hidden" aria-label="Subir foto personal" onChange={e => void upload(e.target.files, 'profile')}/>
        {tab === 'inicio' && <>
          <div className="page-heading"><div><span className="eyebrow">MENOS DUDAS, MÁS ESTILO</span><h1>Tu ropa, nuevas posibilidades.</h1><p>Redescubre lo que tienes. Vístete como te sientes.</p></div><span className="date-label">{new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'long' }).format(new Date())}</span></div>
          <section className="hero"><div className="hero-copy"><span className="tiny-tag"><Sparkles size={14}/> UN ESTILISTA, EN TU ARMARIO</span><h2>El mejor look empieza<br/>con lo que ya tienes.</h2><p>Un lugar para tu ropa y nuevas ideas para combinarla.<br className="desktop-only"/> Del lunes en la oficina a esa cita especial.</p><button className="button primary" onClick={() => confirmed.length ? navigate('ideas') : fileRef.current?.click()} disabled={!!busy}>{confirmed.length ? 'Encontrar mi próximo look' : 'Añadir mis primeras prendas'}<ArrowRight size={17}/></button><small>Hecho con tus prendas. Pensado para ti.</small></div><ClosetArt/></section>
          <div className="stats"><button onClick={() => navigate('armario')}><span className="stat-icon"><Shirt size={22}/></span><div><strong>{data.garments.length}</strong><span>Prendas en tu armario</span></div><ChevronRight size={17}/></button><button onClick={() => { setFavoritesOnly(true); navigate('ideas'); }}><span className="stat-icon rose"><Heart size={22}/></span><div><strong>{data.outfits.filter(o => o.favorite).length}</strong><span>Looks favoritos</span></div><ChevronRight size={17}/></button><button onClick={() => navigate('semana')}><span className="stat-icon sage"><CalendarDays size={22}/></span><div><strong>{data.events.filter(e => dates.includes(e.date) && e.outfit_id).length}</strong><span>Planes con conjunto esta semana</span></div><ChevronRight size={17}/></button></div>
          <div className="section-heading"><div><h2>Un look para cada momento</h2><p>¿Qué tienes en mente?</p></div><button className="text-button" onClick={() => navigate('ideas')}>Ver ideas <ArrowRight size={16}/></button></div>
          <div className="occasion-grid">{OCCASIONS.map((o, i) => <button className={`occasion-tile tone-${i}`} key={o} onClick={() => { setOccasion(o); setLatestIds(null); setFavoritesOnly(false); navigate('ideas'); }}><span>{['☕', '♡', '✧', '☾', '☀'][i]}</span><strong>{occasionLabels[o]}</strong><small>{['Tu día, con confianza', 'Un toque de ti', 'Para recordar', 'Cuando cae el sol', 'A tu ritmo'][i]}</small><ArrowRight size={16}/></button>)}</div>
          <div className="home-bottom"><section className="paper"><span className="eyebrow">PASO A PASO</span><h2>Tu armario empieza aquí</h2><ol className="steps"><li><span>01</span><div><strong>Fotografía tus prendas</strong><p>Una por foto, completa y con buena luz.</p></div></li><li><span>02</span><div><strong>Encuentra nuevas combinaciones</strong><p>Ideas con la ropa que ya tienes.</p></div></li><li><span>03</span><div><strong>Mírate y planea tu semana</strong><p>Elige un look y crea una simulación sobre tu foto.</p></div></li></ol></section><section className="week-teaser"><CalendarDays size={25}/><span className="eyebrow">UN POCO DE ORGANIZACIÓN</span><h2>Una semana con<br/>menos “¿qué me pongo?”</h2><p>Asigna una ocasión a cada día y deja tus conjuntos preparados.</p><button className="button secondary" onClick={() => navigate('semana')}>Planear mi semana <ArrowRight size={16}/></button></section></div>
        </>}
        {tab === 'armario' && <>
          <div className="page-heading"><div><span className="eyebrow">LO QUE YA ES TUYO</span><h1>Mi armario</h1><p>Cada prenda tiene más de una posibilidad.</p></div><button className="button primary" disabled={!!busy} onClick={() => fileRef.current?.click()}><Plus size={18}/> Añadir prendas</button></div>
          <div className="upload-tip"><ImagePlus size={23}/><p><strong>Una prenda por foto, sin complicaciones.</strong> Fotografía la prenda completa con buena luz y un fondo sencillo. Puedes elegir varias fotos a la vez. JPG, PNG o WebP · hasta 10 MB cada una.</p></div>
          <div className="filters"><label className="search"><Search size={18}/><input placeholder="Buscar prenda o color…" aria-label="Buscar prenda o color" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="Filtrar categoría" value={category} onChange={e => setCategory(e.target.value)}><option value="">Todas las categorías</option>{CATEGORIES.map(c => <option key={c} value={c}>{categoryLabels[c]}</option>)}</select><select aria-label="Filtrar estado" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}><option value="">Todos los estados</option><option value="review">Por confirmar</option><option value="ready">Listas</option><option value="processing">Analizando</option><option value="error">Revisión manual</option></select></div>
          <p className="result-count">{filtered.length} prendas · {confirmed.length} confirmadas</p>
          {filtered.length ? <div className="garment-grid">{filtered.map(g => <button className="garment-card" key={g.id} onClick={() => setEditing(g)}><div className="garment-image"><img src={g.thumbnail_url} alt={g.name}/><span className={`badge ${g.status === 'ready' ? 'green' : ''}`}>{statusLabels[g.status]}</span></div><div className="garment-info"><span>{categoryLabels[g.category]}</span><h3>{g.name}</h3><p>{g.colors.join(' · ') || 'Analizando colores'}{!g.available && ' · No disponible'}</p></div></button>)}</div> : <EmptyState icon={<Shirt size={34}/>} title={data.garments.length ? 'No hay prendas con estos filtros' : 'Un espacio para toda tu ropa'} description={data.garments.length ? 'Prueba otra categoría, estado o búsqueda.' : 'Empieza con tus prendas favoritas. El estilista podrá combinarlas cuando confirmes su clasificación.'} action={!data.garments.length ? <button className="button primary" onClick={() => fileRef.current?.click()}><Upload size={17}/> Subir mis primeras fotos</button> : undefined}/>}
        </>}
        {tab === 'ideas' && <>
          <div className="page-heading"><div><span className="eyebrow">INSPIRACIÓN CON TU ROPA</span><h1>¿Qué te apetece llevar?</h1><p>Tres propuestas cuando tu armario permita combinaciones distintas.</p></div><Sparkles className="heading-icon" size={34}/></div>
          {eventTarget && <div className="setup-banner"><CalendarDays size={18}/><span>Eligiendo para el {eventTarget.date} · {occasionLabels[eventTarget.occasion]}</span><button onClick={() => setEventTarget(null)}>Cancelar</button></div>}
          <section className="ideas-form paper"><label className="field-label">La ocasión</label><div className="occasion-chips">{OCCASIONS.map(o => <button className={occasion === o ? 'selected' : ''} onClick={() => setOccasion(o)} key={o}>{occasionLabels[o]}</button>)}</div><label className="field-label" htmlFor="notes">Dale tu toque <span>opcional</span></label><textarea id="notes" value={notes} maxLength={500} onChange={e => setNotes(e.target.value)} placeholder="Por ejemplo: cómodo y elegante, una cena tranquila, sin tacones…"/><div className="row"><p className="muted">Solo tus prendas confirmadas y disponibles.</p><button className="button primary" onClick={() => void suggest()} disabled={!!busy || !!suggestionJob}><Sparkles size={17}/>{suggestionJob ? 'Preparando ideas…' : 'Crear mis propuestas'}</button></div></section>
          <div className="section-heading"><h2>{latestIds ? 'Tus nuevas propuestas' : 'Tus conjuntos'}</h2><button className={`text-button ${favoritesOnly ? 'liked' : ''}`} onClick={() => { setFavoritesOnly(!favoritesOnly); setLatestIds(null); }}><Heart size={17}/> {favoritesOnly ? 'Ver todos' : 'Solo favoritos'}</button></div>
          {currentOutfits.length ? <div className="look-grid">{currentOutfits.map(outfitCard)}</div> : <EmptyState icon={<Sparkles size={34}/>} title={favoritesOnly ? 'Tus favoritos vivirán aquí' : 'Nuevas ideas, con tus propias prendas'} description={favoritesOnly ? 'Marca el corazón de los conjuntos que quieras volver a usar.' : 'Elige la ocasión y pide tus propuestas. Generarás una imagen sobre tu foto solo después de elegir un conjunto.'}/>}
        </>}
        {tab === 'semana' && <>
          <div className="page-heading"><div><span className="eyebrow">LISTO PARA LO QUE VIENE</span><h1>Una semana a tu estilo</h1><p>Trabajo por la mañana, cita por la noche. Hay lugar para ambos.</p></div><button className="button primary" onClick={() => { if (ready()) setEventEditor({ date: todayLima(), occasion: 'trabajo', notes: '', outfit_id: null }); }}><Plus size={18}/> Añadir ocasión</button></div>
          <div className="week-controls"><button className="icon-button" aria-label="Semana anterior" onClick={() => { const d = new Date(`${week}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 7); setWeek(d.toISOString().slice(0, 10)); }}><ChevronLeft size={21}/></button><h2>{new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(dates[0]))} — {new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(dates[6]))}</h2><button className="icon-button" aria-label="Semana siguiente" onClick={() => { const d = new Date(`${week}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); setWeek(d.toISOString().slice(0, 10)); }}><ChevronRight size={21}/></button><button className="text-button" onClick={() => setWeek(todayLima())}>Hoy</button></div>
          <div className="week-grid">{dates.map(date => <section className={`day-column ${date === todayLima() ? 'today' : ''}`} key={date}><div className="day-title"><span>{new Intl.DateTimeFormat('es', { weekday: 'short', timeZone: 'UTC' }).format(new Date(date))}</span><strong>{Number(date.slice(-2))}</strong></div>{data.events.filter(e => e.date === date).map(e => { const o = data.outfits.find(o => o.id === e.outfit_id); return <article className="event-card" key={e.id}><div className="row"><strong>{occasionLabels[e.occasion]}</strong><button className="icon-button" aria-label="Editar ocasión" onClick={() => setEventEditor(e)}><ChevronRight size={15}/></button></div>{e.notes && <p>{e.notes}</p>}{o && <><div className="event-images">{o.garment_ids.slice(0, 3).map(id => { const g = data.garments.find(g => g.id === id); return g && <img key={id} src={g.thumbnail_url} alt={g.name}/>; })}</div><button className="event-look" onClick={() => setSelected(o)}>{o.title}</button></>}<button className="text-button" onClick={() => openForEvent(e)}><Sparkles size={13}/>{o ? 'Cambiar look' : 'Elegir look'}</button></article>; })}<button className="add-day" aria-label={`Añadir ocasión el ${date}`} onClick={() => { if (ready()) setEventEditor({ date, occasion: 'casual', notes: '', outfit_id: null }); }}><Plus size={17}/><span>Añadir ocasión</span></button></section>)}</div><p className="muted calendar-note">La agenda guarda tus conjuntos sin generar imágenes automáticamente. Puedes reutilizar un look en varios días.</p>
        </>}
        {tab === 'perfil' && <>
          <div className="page-heading"><div><span className="eyebrow">TAN PERSONAL COMO TU ESTILO</span><h1>Mi perfil</h1><p>Cuéntale al estilista qué te gusta.</p></div></div>
          <div className="profile-grid"><section className="paper photo-panel"><h2>Tu foto de referencia</h2>{data.profile.photo_url ? <img className="profile-photo" src={data.profile.photo_url} alt="Tu foto de referencia de cuerpo completo"/> : <div className="photo-placeholder"><UserRound size={45}/><span>Aquí empieza la simulación</span></div>}<p>Foto de cuerpo completo, de frente, con buena luz y ropa sencilla. La IA no calculará tus medidas.</p><button className="button secondary full" disabled={!!busy} onClick={() => profileFileRef.current?.click()}><ImagePlus size={17}/>{data.profile.photo_url ? 'Cambiar mi foto' : 'Subir mi foto'}</button>{data.profile.photo_path && <button className="text-button danger" disabled={!!busy} onClick={() => void act('Eliminando foto…', async () => { await api('profile-photo', 'DELETE'); setNotice('Foto retirada. Se han retirado también sus simulaciones.'); })}><Trash2 size={15}/> Eliminar foto y simulaciones</button>}<small><LockKeyhole size={12}/> Se envía al servicio de IA solo al solicitar una simulación.</small></section>
            <ProfileForm profile={data.profile} busy={!!busy} onSave={input => { if (ready()) void act('Guardando preferencias…', async () => { await api('profile', 'PATCH', input); setNotice('Preferencias guardadas.'); }); }}/>
          </div><section className="paper usage-panel"><div><h2>Tu uso de imágenes</h2><p>{data.image_requests} solicitudes este mes · límite de {data.profile.monthly_image_limit}</p><p className="muted">El límite cuenta solicitudes, incluidas las fallidas o inciertas. El coste depende del servicio de IA.</p></div><div className="usage-meter"><span style={{ width: `${Math.min(100, data.image_requests / Math.max(1, data.profile.monthly_image_limit) * 100)}%` }}/></div></section>
          <section className="paper jobs-panel"><h2>Procesos recientes</h2>{data.jobs.length ? data.jobs.slice(0, 15).map(j => <div className="job-row" key={j.id}><div><strong>{kindLabels[j.kind]}</strong><small>{new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(j.created_at))}</small>{j.error && <p>{j.error}</p>}{j.kind === 'cleanup' && j.status === 'failed' && <button className="text-button" disabled={!!busy} onClick={() => void act('Reintentando eliminación…', async () => { await api(`jobs/${j.id}/retry-cleanup`, 'POST', {}); })}>Reintentar eliminación</button>}</div><span className={`badge ${j.status === 'succeeded' ? 'green' : ''}`}>{statusLabels[j.status]}</span></div>) : <p className="muted">Aquí verás el progreso de tus fotos, propuestas y simulaciones.</p>}</section>
        </>}
        {loggedIn && data.pending_jobs > 0 && <p className="muted calendar-note" role="status">Tus solicitudes están guardadas. El procesador puede tardar cerca de un minuto en iniciarse. Mantén la web abierta para seguir el progreso y retomar cualquier trabajo pendiente.</p>}
        <footer>atelier <span>Un armario más consciente. Un estilo más tuyo.</span><LockKeyhole size={13}/></footer>
      </div>
    </main>
    {loginOpen && <Modal title="Tu espacio privado" onClose={() => setLoginOpen(false)}><p className="muted">Entra con la cuenta autorizada de tu armario.</p><form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void act('Abriendo tu armario…', async () => { await api('login', 'POST', { email: f.get('email'), password: f.get('password') }); await refresh(); setLoginOpen(false); }); }}><label className="field-label" htmlFor="email">Correo</label><input id="email" name="email" type="email" autoComplete="username" required/><label className="field-label" htmlFor="password">Contraseña</label><input id="password" name="password" type="password" autoComplete="current-password" required/>{error && <p className="warning" role="alert">{error}</p>}<button className="button primary full" disabled={!!busy || !configured}>{busy || 'Abrir mi armario'}<ArrowRight size={17}/></button>{!configured && <p className="muted">El almacenamiento privado todavía no está conectado.</p>}</form></Modal>}
    {editing && <Modal title="Confirma tu prenda" onClose={() => setEditing(null)}><GarmentForm garment={editing} busy={!!busy} onSave={input => void act('Guardando prenda…', async () => { await api(`garments/${editing.id}`, 'PATCH', input); setEditing(null); setNotice('Prenda confirmada y lista para combinar.'); })} onDelete={() => void act('Retirando prenda…', async () => { await api(`garments/${editing.id}`, 'DELETE'); setEditing(null); setNotice('Prenda retirada. Sus imágenes se eliminarán del almacenamiento privado.'); })}/>{error && <p className="warning" role="alert">{error}</p>}</Modal>}
    {eventEditor && <Modal title={eventEditor.id ? 'Editar ocasión' : 'Una ocasión para tu semana'} onClose={() => setEventEditor(null)}><EventForm event={eventEditor} busy={!!busy} onSave={input => void act('Guardando ocasión…', async () => { await api(eventEditor.id ? `events/${eventEditor.id}` : 'events', eventEditor.id ? 'PATCH' : 'POST', input, crypto.randomUUID()); setWeek(input.date); setEventEditor(null); })} onDelete={eventEditor.id ? () => void act('Eliminando ocasión…', async () => { await api(`events/${eventEditor.id}`, 'DELETE'); setEventEditor(null); }) : undefined}/>{error && <p className="warning" role="alert">{error}</p>}</Modal>}
    {selected && <Modal title={selected.title} onClose={() => setSelected(null)} wide><LookDetail outfit={selected} data={data} busy={!!busy} error={error}
      onRender={() => { if (ready()) void act('Solicitando simulación…', async () => { const r = await api<{ cached?: boolean }>('render', 'POST', { outfit_id: selected.id }, crypto.randomUUID()); setNotice(r.cached ? 'Se ha reutilizado tu simulación guardada.' : 'Imagen solicitada. Verás aquí el resultado cuando esté listo.'); }); }}
      onReplace={(oldId, newId) => void act('Creando nueva combinación…', async () => { const r = await api<{ id: string }>('outfits', 'POST', { title: `${selected.title.replace(/ · personalizado$/, '')} · personalizado`, explanation: selected.explanation, occasion: selected.occasion, garment_ids: selected.garment_ids.map(id => id === oldId ? newId : id), missing: [] }); const snapshot = await refresh(); if (snapshot) setSelected(snapshot.outfits.find(o => o.id === r.id)!); })}
      onSchedule={() => { setEventEditor({ date: todayLima(), occasion: selected.occasion, notes: '', outfit_id: selected.id }); setSelected(null); }}
      onDeleteSimulation={id => void act('Eliminando imagen…', async () => { await api(`simulations/${id}`, 'DELETE'); setNotice('Simulación retirada.'); })}/></Modal>}
  </div>;
}

function EmptyState({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) { return <div className="empty-state"><div>{icon}</div><h2>{title}</h2><p>{description}</p>{action}</div>; }
function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null; ref.current?.focus(); const old = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab') { const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]') || []); const first = items[0], last = items.at(-1); if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', handler); return () => { document.body.style.overflow = old; document.removeEventListener('keydown', handler); prev?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} tabIndex={-1} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-heading"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Cerrar ventana" onClick={onClose}><X size={22}/></button></div>{children}</div></div>;
}
function ProfileForm({ profile, busy, onSave }: { profile: Profile; busy: boolean; onSave: (data: unknown) => void }) {
  return <form key={`${profile.user_id}:${profile.updated_at ?? ''}`} className="paper profile-form" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const list = (key: string) => String(f.get(key)).split(',').map(v => v.trim()).filter(Boolean); onSave({ display_name: f.get('display_name'), styles: list('styles'), favorite_colors: list('colors'), work_formality: Number(f.get('formality')), monthly_image_limit: Number(f.get('limit')) }); }}>
    <h2>Tu estilo, tus reglas</h2><label className="field-label" htmlFor="display-name">¿Cómo te llamas?</label><input id="display-name" name="display_name" defaultValue={profile.display_name} maxLength={70} required/>
    <label className="field-label" htmlFor="styles">Estilos que te gustan</label><input id="styles" name="styles" defaultValue={profile.styles.join(', ')} placeholder="Minimalista, clásico, urbano…"/><small>Separa cada estilo con una coma.</small>
    <label className="field-label" htmlFor="colors">Colores favoritos</label><input id="colors" name="colors" defaultValue={profile.favorite_colors.join(', ')} placeholder="Crema, negro, verde oliva…"/>
    <label className="field-label" htmlFor="formality">Formalidad en el trabajo</label><select id="formality" name="formality" defaultValue={profile.work_formality}><option value="1">Muy informal</option><option value="2">Informal</option><option value="3">Elegante y cómodo</option><option value="4">Formal</option><option value="5">Muy formal</option></select>
    <label className="field-label" htmlFor="limit">Límite mensual de solicitudes de imagen</label><input id="limit" name="limit" type="number" min="0" max="1000" defaultValue={profile.monthly_image_limit} required/><small>Predeterminado: 30. No equivale a un límite de gasto.</small><button className="button primary" disabled={busy} type="submit"><Check size={17}/> Guardar preferencias</button>
  </form>;
}
function GarmentForm({ garment: g, busy, onSave, onDelete }: { garment: Garment; busy: boolean; onSave: (input: unknown) => void; onDelete: () => void }) {
  return <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); onSave({ name: f.get('name'), category: f.get('category'), colors: String(f.get('colors')).split(',').map(v => v.trim()).filter(Boolean), pattern: f.get('pattern'), formality: Number(f.get('formality')), available: f.get('available') === 'on', status: 'ready' }); }}><img className="edit-photo" src={g.photo_url || g.thumbnail_url} alt={g.name}/><p className="muted">Revisa la clasificación. Puedes corregirla incluso si el análisis de IA falló.</p><label className="field-label" htmlFor="g-name">Nombre</label><input id="g-name" name="name" defaultValue={g.name} maxLength={100} required/><label className="field-label" htmlFor="g-category">Categoría</label><select id="g-category" name="category" defaultValue={g.category}>{CATEGORIES.map(c => <option key={c} value={c}>{categoryLabels[c]}</option>)}</select><label className="field-label" htmlFor="g-colors">Colores, separados por comas</label><input id="g-colors" name="colors" defaultValue={g.colors.join(', ')} required/><label className="field-label" htmlFor="g-pattern">Estampado</label><input id="g-pattern" name="pattern" defaultValue={g.pattern} maxLength={60} required/><label className="field-label" htmlFor="g-formality">Formalidad</label><select id="g-formality" name="formality" defaultValue={g.formality}>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} · {['Muy informal', 'Informal', 'Intermedia', 'Formal', 'Muy formal'][n - 1]}</option>)}</select><label className="checkbox"><input name="available" type="checkbox" defaultChecked={g.available}/> Disponible para usar</label><div className="row"><button type="button" className="text-button danger" onClick={onDelete} disabled={busy}><Trash2 size={16}/> Retirar prenda</button><button className="button primary" disabled={busy}><Check size={17}/> Confirmar prenda</button></div></form>;
}
function EventForm({ event, busy, onSave, onDelete }: { event: Partial<AgendaEvent>; busy: boolean; onSave: (input: Omit<AgendaEvent, 'id'>) => void; onDelete?: () => void }) {
  return <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); onSave({ date: String(f.get('date')), occasion: f.get('occasion') as AgendaEvent['occasion'], notes: String(f.get('notes')), outfit_id: event.outfit_id || null }); }}><label className="field-label" htmlFor="e-date">Día</label><input id="e-date" name="date" type="date" defaultValue={event.date} required/><label className="field-label" htmlFor="e-occasion">Ocasión</label><select id="e-occasion" name="occasion" defaultValue={event.occasion}>{OCCASIONS.map(o => <option key={o} value={o}>{occasionLabels[o]}</option>)}</select><label className="field-label" htmlFor="e-notes">Detalles</label><textarea id="e-notes" name="notes" maxLength={500} defaultValue={event.notes} placeholder="Cena a las 8, reunión importante…"/><div className="row">{onDelete && <button type="button" className="text-button danger" disabled={busy} onClick={onDelete}><Trash2 size={16}/> Eliminar</button>}<button className="button primary" disabled={busy}>Guardar ocasión <Check size={17}/></button></div></form>;
}
function LookDetail({ outfit, data, busy, error, onRender, onReplace, onSchedule, onDeleteSimulation }: { outfit: Outfit; data: Snapshot; busy: boolean; error: string; onRender: () => void; onReplace: (oldId: string, newId: string) => void; onSchedule: () => void; onDeleteSimulation: (id: string) => void }) {
  const simulation = data.simulations.find(s => s.outfit_id === outfit.id); const job = data.jobs.find(j => j.kind === 'render' && j.outfit_id === outfit.id);
  const processing = job && ['running', 'queued'].includes(job.status);
  const valid = outfit.garment_ids.every(id => data.garments.some(g => g.id === id && g.status === 'ready' && g.available));
  return <><p>{outfit.explanation}</p><div className="look-detail"><section><h3>Las prendas reales</h3><div className="detail-garments">{outfit.garment_ids.map(id => { const g = data.garments.find(g => g.id === id); return g ? <div key={id}><img src={g.thumbnail_url} alt={g.name}/><strong>{g.name}</strong><label className="visually-hidden" htmlFor={`replace-${id}`}>Cambiar {g.name}</label><select id={`replace-${id}`} value={id} disabled={busy} onChange={e => onReplace(id, e.target.value)}>{data.garments.filter(item => item.category === g.category && item.status === 'ready' && item.available && (item.id === id || !outfit.garment_ids.includes(item.id))).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div> : <p key={id} className="warning">Prenda retirada</p>; })}</div>{outfit.missing.length > 0 && <p className="warning">Falta: {outfit.missing.join(', ')}</p>}</section><section className="simulation-panel"><h3>Así podría verse en ti</h3>{simulation?.image_url ? <><img className="simulation-image" src={simulation.image_url} alt={`Simulación aproximada de ${outfit.title} sobre tu foto`}/><button className="text-button danger" onClick={() => onDeleteSimulation(simulation.id)} disabled={busy}><Trash2 size={14}/> Eliminar simulación</button></> : <div className="simulation-empty"><Sparkles size={35}/><p>Elige este look y crea una imagen sobre tu foto.</p><button className="button primary" disabled={busy || processing || !valid || outfit.missing.length > 0} onClick={onRender}><Sparkles size={16}/>{processing ? 'Generando imagen…' : 'Verme con este look'}</button>{!data.profile.photo_path && <small>Sube primero tu foto en Mi perfil.</small>}</div>}<p className="simulation-note">Simulación aproximada: pueden variar colores, estampados y cortes. No comprueba el ajuste de la ropa.</p>{job?.error && <p className="warning">{job.error}</p>}</section></div>{error && <p role="alert" className="warning">{error}</p>}<button className="button secondary" disabled={busy || !valid} onClick={onSchedule}><CalendarDays size={17}/> Guardar en mi semana</button></>;
}
