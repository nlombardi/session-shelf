// Build script for the extension. No global fetch/network needed.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * In watch mode, print a start/finish marker around every rebuild and each error on
 * one line, so the "npm: watch" task's problem matcher (.vscode/tasks.json) can tell
 * when a build is running and put errors in the Problems panel.
 */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        if (location) {
          console.error(`${location.file}:${location.line}:${location.column + 1}: error: ${text}`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    plugins: watch ? [problemMatcherPlugin] : [],
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching…');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
