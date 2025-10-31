/** @import { Dirent } from 'fs' */
import { readFile, readdir, writeFile, rm, mkdir, cp, stat } from 'fs/promises';
import { cpSync, existsSync } from 'fs';
import { join, parse } from 'path';
import { transform } from 'lightningcss';
import { createHash } from 'crypto';
import { rollup } from 'rollup';
import { minify } from 'html-minifier-terser';
import minify_xml from 'minify-xml';
import rollup_config from '../../rollup.config.js';
import { ROUTES } from './constants.js';

let running = false;

/**
 * @param {string} [dir]
 * @param {boolean} [dev]
 */
export default async function build(dir = ROUTES, dev = false) {
    // we treat this as a semaphore to avoid rerunning when a build hasn't completed
    // which can lead to errors (e.g. `.tmp` folder gets deleted by new build, while old build is still copying files over)
    if (running) {
        return;
    }
    try {
        if (existsSync(join(process.cwd(), '.tmp'))) {
            await rm(join(process.cwd(), '.tmp'), { recursive: true });
        }

        await mkdir(join(process.cwd(), '.tmp'));

        for (const file of await readdir(join(process.cwd(), 'src', dir), {
            recursive: true,
            withFileTypes: true
        })) {
            if (!file.isFile()) continue;
            const { ext } = parse(file.name);
            const path = join(file.parentPath, file.name).replace(
                join(process.cwd(), 'src', dir),
                join(process.cwd(), '.tmp')
            );
            if (!existsSync(path)) {
                await cp(join(file.parentPath, file.name), path, {
                    recursive: true
                });
            }
            if (ext === '.css') {
                const transformed = transform({
                    minify: true,
                    code: await readFile(path),
                    filename: join(file.parentPath, file.name)
                });
                await writeFile(path, transformed.code);
            }
            if (ext === '.js') {
                const bundle = await rollup({
                    input: join(file.parentPath, file.name),
                    ...rollup_config
                });
                await bundle.write({
                    file: path,
                    sourcemap: (dev && 'inline') || false
                });
            }
            if (ext === '.html') {
                const html = await readFile(path, 'utf-8');
                const minified = await minify(html, {
                    removeComments: true,
                    removeAttributeQuotes: true,
                    collapseWhitespace: true,
                    useShortDoctype: true
                });
                await writeFile(path, minified);
            }
            if (ext === '.svg' || ext === '.xml') {
                const xml = await readFile(path, 'utf-8');
                const minified = minify_xml(xml);
                await writeFile(path, minified);
            }
        }

        if (existsSync(join(process.cwd(), 'src', 'netlify.toml'))) {
            cpSync(
                join(process.cwd(), 'src', 'netlify.toml'),
                join(process.cwd(), 'dist', 'netlify.toml'),
                { recursive: true }
            );
        }
        await reconcile(
            join(process.cwd(), '.tmp'),
            join(process.cwd(), 'dist')
        );
        await rm(join(process.cwd(), '.tmp'), { recursive: true });
    } finally {
        running = false;
    }
}

/**
 * Performs the minimum amount of changes necessary
 * to make the `destination` folder have the same contents
 * as the `source` folder.
 * @param {string} source
 * @param {string} destination
 */
async function reconcile(source, destination) {
    if (!existsSync(destination)) {
        await cp(source, destination, { recursive: true });
    }
    for (const original of await readdir(destination, {
        withFileTypes: true
    })) {
        if (!existsSync(join(source, original.name))) {
            await rm(join(destination, original.name), { recursive: true });
            continue;
        }
        if (
            (await stat(join(source, original.name))).isFile() !==
            original.isFile()
        ) {
            await rm(join(destination, original.name), { recursive: true });
            continue;
        }
    }
    for (const next of await readdir(source, { withFileTypes: true })) {
        if (!existsSync(join(destination, next.name))) {
            await cp(join(source, next.name), join(destination, next.name), {
                recursive: true
            });
            continue;
        }
        if (next.isDirectory()) {
            await reconcile(
                join(source, next.name),
                join(destination, next.name)
            );
            continue;
        }
        if (next.isFile()) {
            const stats = await stat(join(source, next.name));
            const original = await stat(join(destination, next.name));
            if (stats.size !== original.size) {
                await cp(
                    join(source, next.name),
                    join(destination, next.name),
                    {
                        recursive: true
                    }
                );
                continue;
            }
            const tmp = createHash('sha256');
            tmp.update(await readFile(join(source, next.name)));
            const a = tmp.digest('hex');
            const tmp_2 = createHash('sha256');
            tmp_2.update(await readFile(join(destination, next.name)));
            const b = tmp_2.digest('hex');
            if (a !== b) {
                await cp(
                    join(source, next.name),
                    join(destination, next.name),
                    {
                        recursive: true
                    }
                );
            }
        }
    }
}

// `import.meta.main` doesn't seem to work consistently, so we need a fallback
if (import.meta.main || process.argv.includes('--build')) {
    await build();
}
