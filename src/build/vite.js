import { createServer } from 'vite';
import { join } from 'path';
import build_netlify_middleware from './netlify.js';

export const server = await createServer({
    root: join(process.cwd(), 'dist'),
    server: {
        middlewareMode: true
    },
    appType: 'custom'
});
const netlify_middleware = await build_netlify_middleware(server.middlewares);
server.bindCLIShortcuts();
netlify_middleware?.listen(5173);
