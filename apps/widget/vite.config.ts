import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// Library build -> dist/widget.js: one self-contained IIFE that any site loads with a script tag.
// public/index.html (the demo host page) is copied next to it.
export default defineConfig({
  plugins: [preact()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: 'es2019',
    // Keep earlier builds' files out; watch mode rebuilds in place.
    emptyOutDir: true,
    lib: {
      entry: 'src/main.tsx',
      name: 'SupportPilot',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
  preview: { port: 5173, strictPort: true },
});
