/* Container .vsfx: 'VSFX' + header tới 0x75, sau đó các block [u32 len][zlib] (mỗi block 64 KB
 * khi giải nén). Nối lại thành một luồng nhị phân duy nhất. */

async function inflate(u8: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const s = new Blob([u8 as any]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Từ ngưỡng này luồng mới đáng đặt vào bộ nhớ chia sẻ (file nhỏ phân tích tuần tự đã nhanh). */
const SHARED_MIN = 64 * 1024 * 1024;

export async function readStream(buf: ArrayBuffer): Promise<Uint8Array> {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'VSFX') throw new Error('Không phải file VSFX');
  // Các block độc lập nhau: duyệt trước để biết vị trí từng block, rồi giải nén SONG SONG theo cửa sổ (DecompressionStream chạy ngoài luồng JS; trước đây mỗi block
  // `await` tuần tự — file_14: ~4 000 block, 1.3 s). Cửa sổ giới hạn để không giữ quá nhiều block dở dang; kết quả ghép theo đúng thứ tự block.
  const blocks: [number, number][] = [];
  for (let pos = 0x75; pos + 4 <= u8.length;) {
    const cl = dv.getUint32(pos, true);
    blocks.push([pos + 4, cl]);
    pos += 4 + cl;
  }
  // Giải nén thẳng vào một mảng cấp phát SẴN (mỗi block giải nén tối đa 64 KB) thay vì giữ ~4 000 mảng rời rồi nối (đỉnh bộ nhớ 2 × 263 MB với file_14 -> điện thoại hết RAM).
  // Ngoại lệ block lớn hơn 64 KB: nới mảng.
  const BLOCK = 65536, WINDOW = 64;
  // Ngữ cảnh cô lập chéo nguồn (crossOriginIsolated): đặt luồng vào SharedArrayBuffer để các worker phụ quét song song KHÔNG phải sao chép 263 MB (xem parseParallel).
  const canShare = typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const alloc = (n: number, share: boolean) => new Uint8Array(share ? new SharedArrayBuffer(n) : new ArrayBuffer(n));
  const share = canShare && blocks.length * BLOCK >= SHARED_MIN;
  let raw = alloc(blocks.length * BLOCK, share);
  let total = 0;
  for (let i = 0; i < blocks.length; i += WINDOW) {
    const end = Math.min(blocks.length, i + WINDOW);
    const outs = await Promise.all(blocks.slice(i, end).map(([o, cl]) => inflate(u8.subarray(o, o + cl))));
    for (const out of outs) {
      if (total + out.length > raw.length) { const g = alloc(Math.max(raw.length * 2, total + out.length), share); g.set(raw.subarray(0, total)); raw = g; }
      raw.set(out, total);
      total += out.length;
    }
  }
  return raw.subarray(0, total);
}
