import type { Metadata } from 'next';
import './globals.css';
import './cutouts.css';
export const metadata: Metadata = { title: 'Atelier · Tu armario digital', description: 'Tu ropa, nuevas posibilidades. Un armario privado y un estilista para cada ocasión.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="es"><body>{children}</body></html>;
}
