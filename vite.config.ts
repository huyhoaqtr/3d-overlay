import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // worker dùng ES module (import three, các module parser) -> build ra định dạng 'es'
  worker: { format: 'es' },
});
