/* Nhận diện thiết bị ít RAM (điện thoại/máy tính bảng): iPhone, Android, iPad (kể cả khi báo là Mac), hoặc deviceMemory ≤ 4 GB.
 * iOS Safari giết tab ở khoảng 1–1.5 GB nên các chỗ tốn RAM (worker phụ, bản sao luồng, BVH dựng sẵn…) chạy ở chế độ tiết kiệm. Dùng được cả ở main thread lẫn worker. */
interface NavLike { userAgent?: string; platform?: string; maxTouchPoints?: number; deviceMemory?: number }

export function isLowMemoryDevice(): boolean {
  const n = (globalThis as unknown as { navigator?: NavLike }).navigator;
  if (!n) return false;
  return /iPhone|iPad|iPod|Android|Mobile/i.test(n.userAgent ?? '') || (n.platform === 'MacIntel' && (n.maxTouchPoints ?? 0) > 1) || (n.deviceMemory !== undefined && n.deviceMemory <= 4);
}
