import { nodeResolve as node_resolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { defineConfig } from 'rollup';

export default defineConfig({
    treeshake: {
        preset: 'smallest'
    },
    plugins: [
        node_resolve(),
        /** @type {import('@rollup/plugin-terser').default} */ (
            /** @type {unknown} */ (terser)
        )({
            ecma: 2020,
            compress: {
                ecma: 2020,
                passes: 5,
                module: true
            }
        })
    ]
});
