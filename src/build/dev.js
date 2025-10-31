import build from './index.js';
import { join, parse, sep } from 'path';
import { watch } from 'chokidar';
import { ROUTES } from './constants.js';

await build(ROUTES, true);
watch(join(process.cwd(), 'src')).on('change', async path => {
    // if the file changed was in `build`, don't queue a rebuild
    if (
        parse(path.replace(join(process.cwd(), 'src'), '').replace(sep, ''))
            .dir === 'build'
    ) {
        return;
    }
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
import { server } from './vite.js';
