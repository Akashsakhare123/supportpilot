import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// Library build -> dist/widget.js: one self-contained IIFE that any site loads with a script tag.
export default defineConfig({
  plugins: [preact()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: 'es2019',
    lib: {
      entry: 'src/main.tsx',
      name: 'SupportPilot',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
});
