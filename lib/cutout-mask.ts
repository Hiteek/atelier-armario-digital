// Bounds are calculated from the mask, never by changing the original RGB pixels.
export function foregroundBounds(alpha: Uint8Array | Uint8ClampedArray, width: number, height: number) {
  if (alpha.length !== width * height) throw new Error('Máscara inválida.');
  let left = width, top = height, right = -1, bottom = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (alpha[y * width + x] < 24) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
  }
  if (count < width * height * .01 || count > width * height * .995) throw new Error('No se pudo separar bien la prenda. Prueba una foto con un fondo más sencillo.');
  const margin = Math.max(4, Math.ceil(Math.max(right - left, bottom - top) * .04));
  left = Math.max(0, left - margin); top = Math.max(0, top - margin);
  return { left, top, width: Math.min(width, right + margin + 1) - left, height: Math.min(height, bottom + margin + 1) - top };
}
