export function renderEndpoint(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.onrender.com') || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) {
    throw new Error('Configura el origen HTTPS exacto del servicio onrender.com, sin rutas ni credenciales.');
  }
  return new URL('/process', url).toString();
}
