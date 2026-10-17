// `pnpm dev` for the widget: rebuild dist/widget.js on every change and serve dist/ on :5173.
// Serving the real bundle (not Vite's dev modules) means the demo page and the dashboard's
// install snippet use exactly what client websites get.
import { build, preview } from 'vite';

const port = Number(process.env.WIDGET_PORT ?? 5173);

await build({ mode: 'development', build: { watch: {} } });
const server = await preview({ preview: { port, strictPort: true } });
console.log(
  `[widget] demo page: http://localhost:${port}/  bundle: http://localhost:${port}/widget.js`,
);

const stop = () => {
  server.httpServer.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
