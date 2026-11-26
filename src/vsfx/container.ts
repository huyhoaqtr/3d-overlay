/* Container .vsfx: 'VSFX' + header tới 0x75, sau đó các block [u32 len][zlib] (mỗi block 64 KB
 * khi giải nén). Nối lại thành một luồng nhị phân duy nhất. */

async function inflate(u8: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const s = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function readStream(buf: ArrayBuffer): Promise<Uint8Array> {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'VSFX') throw new Error('Không phải file VSFX');
  const parts: Uint8Array[] = [];
  let pos = 0x75, total = 0;
  while (pos + 4 <= u8.length) {
    const cl = dv.getUint32(pos, true);
    const out = await inflate(u8.subarray(pos + 4, pos + 4 + cl));
    parts.push(out); total += out.length; pos += 4 + cl;
  }
  const raw = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { raw.set(p, o); o += p.length; }
  return raw;
}
