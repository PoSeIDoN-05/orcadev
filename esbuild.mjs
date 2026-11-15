// esbuild.mjs -- bundles src/extension.ts into dist/extension.js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  external: ['vscode'],
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info'
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[orcadev] watching src/ ...');
} else {
  await esbuild.build(options);
  console.log('[orcadev] built dist/extension.js');
}
