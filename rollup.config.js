import { nodeResolve as node_resolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { defineConfig } from 'rollup';

export default defineConfig({
    treeshake: {
        preset: 'smallest'
    },
    // @ts-expect-error no idea why this doesn't work
    plugins: [node_resolve(), terser()]
});
