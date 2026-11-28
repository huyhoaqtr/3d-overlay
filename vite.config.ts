import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // COOP/COEP bật crossOriginIsolated -> SharedArrayBuffer: phân tích file lớn song song nhiều worker không phải sao chép luồng 263 MB (không có header thì tự chạy tuần tự)
  server: { port: 5173, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  // worker dùng ES module (import three, các module parser) -> build ra định dạng 'es'
  worker: { format: 'es' },
});
