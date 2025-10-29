import build from './index.js';
import { createServer } from 'vite';
import { join, parse, sep } from 'path';
import { watch } from 'chokidar';
import build_netlify_middleware from './netlify.js';
const ROUTES = 'desktop';
await build(ROUTES, true);
let queued = false;
watch(join(process.cwd(), 'src')).on('change', path => {
    // if the file changed was in `build`, don't queue a rebuild
    if (
        parse(path.replace(join(process.cwd(), 'src'), '').replace(sep, ''))
            .dir === 'build'
    ) {
        return;
    }
    if (!queued) {
        queued = true;
        queueMicrotask(async () => {
            queued = false;
            try {
                await build(ROUTES, true);
            } catch (err) {
                const error = /** @type {Error} */ (err);
                server.hot.send({
                    type: 'error',
                    err: {
                        ...error,
                        message: error.message,
                        stack: error.stack ?? ''
                    }
                });
            }
        });
    }
});
const server = await createServer({
    root: join(process.cwd(), 'dist'),
    server: {
        middlewareMode: true
    },
    appType: 'custom'
});
const netlify_middleware = await build_netlify_middleware(server.middlewares);
server.bindCLIShortcuts();
netlify_middleware?.listen(5173);
