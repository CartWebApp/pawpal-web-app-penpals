// since netlify's vite plugin is dreadfully slow and we don't really use much of netlify,
// i've made a minimal vite server that uses the `netlify.toml` to do redirects
/** @import { Connect } from 'vite'  */
import { parse as toml_parse } from 'toml';
import { existsSync } from 'fs';
import * as v from 'valibot';
import { STATUS_CODES } from 'http';
import { join, parse } from 'path';
import { readFile, stat } from 'fs/promises';
import mime from 'mime';
import colors from 'picocolors';
import { match } from 'path-to-regexp';
import express from 'express';

const redirect_schema = v.object({
    from: v.string(),
    to: v.string(),
    status: v.pipe(
        v.optional(v.number(), 301),
        v.check(status => status in STATUS_CODES)
    ),
    force: v.optional(v.boolean(), false),
    conditions: v.optional(v.record(v.string(), v.array(v.string())), {}),
    headers: v.optional(v.record(v.string(), v.string()), {})
});
const config = v.object({
    redirects: v.optional(v.array(redirect_schema), [])
});

/**
 * @param {Connect.Server} middlewares
 */
export default async function build_netlify_middleware(middlewares) {
    if (!existsSync(join(process.cwd(), 'src', 'netlify.toml'))) {
        return;
    }
    const toml = await readFile(
        join(process.cwd(), 'src', 'netlify.toml'),
        'utf-8'
    );
    const parsed = toml_parse(toml);
    if (typeof parsed === 'object' && parsed !== null) {
        const { redirects = [] } = v.parse(config, parsed);
        if (redirects.length === 0) {
            return;
        }
        /**
         * @param {URL} url
         */
        async function handle(url) {
            const path = join(
                process.cwd(),
                'dist',
                ...url.pathname.split('/')
            );
            if (existsSync(path)) {
                const stats = await stat(path);
                if (stats.isDirectory()) {
                    if (
                        existsSync(join(path, 'index.html')) &&
                        (await stat(join(path, 'index.html'))).isFile()
                    ) {
                        return {
                            status: 200,
                            headers: {
                                'content-type': 'text/html'
                            },
                            body: await readFile(
                                join(path, 'index.html'),
                                'utf-8'
                            )
                        };
                    }
                } else {
                    const { ext } = parse(path);
                    return {
                        status: 200,
                        headers: {
                            'content-type': mime.getType(ext) ?? 'text/plain'
                        },
                        body: await readFile(path)
                    };
                }
            }
            for (const redirect of redirects) {
                if (redirect.force) {
                    continue;
                }
                const pattern = match(
                    redirect.from.replace(/\/\*$/, '/*splat')
                );
                const parsed = pattern(url.pathname);
                if (!parsed) {
                    continue;
                }
                if (!redirect.force) {
                    const to = redirect.to.replace(
                        /:[a-z]+/g,
                        m => /** @type {string} */ (parsed.params[m.slice(1)])
                    );
                    return await handle(new URL(to, 'http://localhost:5173'));
                }
            }
        }
        const app = express();
        /**
         * @param {string} url
         */
        function color_url(url) {
            return colors.cyan(
                url.replace(/:(\d+)\//, (_, port) => `:${colors.bold(port)}/`)
            );
        }
        console.info(
            `  ${colors.green('➜')}  ${colors.bold('Local')}:   ${color_url(
                'localhost:5173'
            )}`
        );
        console.info(
            colors.dim(
                `  ${colors.green('➜')}  ${colors.bold('Network')}: use `
            ) +
                colors.bold('--host') +
                colors.dim(' to expose')
        );
        app.use(middlewares);
        app.use(async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost:5173');
            for (const redirect of redirects) {
                const pattern = match(
                    redirect.from.replace(/\/\*$/, '/*splat')
                );
                const parsed = pattern(req.url ?? '/');
                if (!parsed) {
                    continue;
                }
                if (redirect.force) {
                    const to = redirect.to.replace(
                        /:[a-z]+/g,
                        m => /** @type {string} */ (parsed.params[m.slice(1)])
                    );
                    const response = await handle(
                        new URL(to, 'http://localhost:5173')
                    );
                    res.writeHead(response?.status ?? 500, response?.headers);
                    res.write(response?.body);
                    res.end();
                    return;
                }
            }
            const response = await handle(url);
            res.writeHead(response?.status ?? 500, response?.headers);
            res.write(response?.body);
            res.end();
        });
        return app;
    }
}
