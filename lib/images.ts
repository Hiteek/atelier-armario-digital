import sharp from 'sharp';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export async function preparePhoto(file: File) {
  if (file.size === 0 || file.size > MAX_FILE_BYTES) throw new Error('La foto debe pesar como máximo 10 MB.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Usa una foto JPG, PNG o WebP.');
  const bytes = Buffer.from(await file.arrayBuffer());
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('La imagen debe ser una foto estática válida.');
  // rotate() applies EXIF orientation; re-encoding removes location and camera metadata.
  const photo = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate()
    .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#f6f3ee' })
    .jpeg({ quality: 90 }).toBuffer();
  const thumbnail = await sharp(photo).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  return { photo, thumbnail };
}

export async function prepareCutout(file: File) {
  if (file.type !== 'image/webp' || file.size === 0 || file.size > 3 * 1024 * 1024) throw new Error('Invalid cutout');
  const bytes = Buffer.from(await file.arrayBuffer());
  const metadata = await sharp(bytes, { limitInputPixels: 4_000_000 }).metadata();
  if (metadata.format !== 'webp' || !metadata.hasAlpha || (metadata.pages ?? 1) > 1) throw new Error('Invalid cutout');
  const photo = await sharp(bytes, { limitInputPixels: 4_000_000 }).rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 92, alphaQuality: 100 }).toBuffer();
  const thumbnail = await sharp(photo).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88, alphaQuality: 100 }).toBuffer();
  return { photo, thumbnail };
}
