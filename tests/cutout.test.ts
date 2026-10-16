import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { alphaFromLogits, foregroundBounds } from '../lib/cutout-mask';
import { prepareCutout } from '../lib/images';

describe('Recortes sin alterar el original', () => {
  it('interpreta correctamente float16 crudo de WebGPU y float32 de WASM', () => {
    // IEEE754 binary16: -10, -1, 0, +1, +10. Reading the bits as numbers made every pixel opaque.
    expect([...alphaFromLogits(new Uint16Array([0xc900,0xbc00,0,0x3c00,0x4900]),'float16')]).toEqual([0,69,128,186,255]);
    expect([...alphaFromLogits(new Float32Array([-10,-1,0,1,10]),'float32')]).toEqual([0,69,128,186,255]);
    expect(()=>alphaFromLogits(new Float32Array([NaN]),'float32')).toThrow();
  });
  it('recorta el espacio sobrante con margen y rechaza máscaras vacías o completamente opacas', () => {
    const mask = new Uint8Array(100 * 100);
    for (let y=25;y<75;y++) for (let x=30;x<70;x++) mask[y*100+x]=255;
    expect(foregroundBounds(mask,100,100)).toEqual({left:26,top:21,width:48,height:58});
    expect(()=>foregroundBounds(new Uint8Array(100),10,10)).toThrow();
    expect(()=>foregroundBounds(new Uint8Array(100).fill(255),10,10)).toThrow();
  });
  it('conserva transparencia y colores al crear la foto y miniatura, sin metadatos EXIF', async () => {
    const original = await sharp({create:{width:800,height:800,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
      .composite([{input:await sharp({create:{width:300,height:500,channels:4,background:{r:180,g:20,b:40,alpha:1}}}).png().toBuffer(),left:250,top:150}]).webp({lossless:true}).withMetadata().toBuffer();
    const {photo,thumbnail}=await prepareCutout(new File([new Uint8Array(original)],'cutout.webp',{type:'image/webp'}));
    expect((await sharp(photo).metadata()).hasAlpha).toBe(true);
    expect((await sharp(thumbnail).metadata()).width).toBe(512);
    expect((await sharp(photo).metadata()).exif).toBeUndefined();
    const {data,info}=await sharp(photo).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    expect(data[3]).toBe(0);
    const center=(400*info.width+400)*4;
    expect(data[center]).toBeGreaterThan(160); expect(data[center+1]).toBeLessThan(40); expect(data[center+3]).toBe(255);
    await expect(prepareCutout(new File([new Uint8Array(original)],'fake.jpg',{type:'image/jpeg'}))).rejects.toThrow();
  });
});
