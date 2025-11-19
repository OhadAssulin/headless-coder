import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: false,
  minify: false,
  target: 'node18',
  platform: 'node',
  tsconfig: 'tsconfig.build.json',
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.js' : '.cjs' };
  },
  esbuildOptions(options) {
    options.logOverride = {
      ...(options.logOverride ?? {}),
      'empty-import-meta': 'silent',
    };
  },
});
