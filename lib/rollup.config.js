import typescript from '@rollup/plugin-typescript'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'
import json from '@rollup/plugin-json'

const production = !process.env.ROLLUP_WATCH

// Shared TypeScript plugin configuration
const createTypeScriptPlugin = (options = {}) => typescript({
  tsconfig: './tsconfig.json',
  noEmitOnError: true,
  ...options
})

// Warning filter to suppress noisy third-party warnings
const onwarn = (warning, warn) => {
  // Skip circular dependency warnings from node_modules or external packages (bee-js, zod, etc.)
  if (warning.code === 'CIRCULAR_DEPENDENCY' &&
      warning.ids?.some(id => id.includes('node_modules') || id.includes('/bee-js/') || id.includes('/zod/'))) {
    return
  }
  // Skip missing export warnings for Node.js built-ins
  if (warning.code === 'MISSING_EXPORT' &&
      warning.exporter?.includes('node-resolve:empty')) {
    return
  }
  // Show all other warnings
  warn(warning)
}

export default [
  // ESM build
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/swarm-id.esm.js',
      format: 'esm',
      sourcemap: true
    },
    onwarn,
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false,
        // Skip Node.js built-ins entirely
        skip: ['tty', 'util', 'os', 'stream', 'path', 'http', 'https', 'url',
               'fs', 'assert', 'zlib', 'events', 'net', 'tls', 'crypto', 'buffer']
      }),
      commonjs(),
      json(),
      createTypeScriptPlugin({
        declaration: true,
        declarationDir: './dist',
        outDir: './dist'
      }),
      production && terser()
    ],
    external: []
  },
  // UMD build
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/swarm-id.umd.js',
      format: 'umd',
      name: 'SwarmId',
      sourcemap: true
    },
    onwarn,
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false,
        skip: ['tty', 'util', 'os', 'stream', 'path', 'http', 'https', 'url',
               'fs', 'assert', 'zlib', 'events', 'net', 'tls', 'crypto', 'buffer']
      }),
      commonjs(),
      json(),
      createTypeScriptPlugin(),
      production && terser()
    ],
    external: []
  },
  // Separate build for swarm-id-client (no code-splitting)
  {
    input: 'src/swarm-id-client.ts',
    output: {
      file: 'dist/swarm-id-client.js',
      format: 'esm',
      sourcemap: true
    },
    onwarn,
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false,
        skip: ['tty', 'util', 'os', 'stream', 'path', 'http', 'https', 'url',
               'fs', 'assert', 'zlib', 'events', 'net', 'tls', 'crypto', 'buffer']
      }),
      commonjs(),
      json(),
      createTypeScriptPlugin(),
      production && terser()
    ],
    external: []
  },
  // Separate build for swarm-id-proxy (no code-splitting)
  {
    input: 'src/swarm-id-proxy.ts',
    output: {
      file: 'dist/swarm-id-proxy.js',
      format: 'esm',
      sourcemap: true
    },
    onwarn,
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false,
        skip: ['tty', 'util', 'os', 'stream', 'path', 'http', 'https', 'url',
               'fs', 'assert', 'zlib', 'events', 'net', 'tls', 'crypto', 'buffer']
      }),
      commonjs(),
      json(),
      createTypeScriptPlugin(),
      production && terser()
    ],
    external: []
  },
  // Separate build for swarm-id-auth (no code-splitting)
  {
    input: 'src/swarm-id-auth.ts',
    output: {
      file: 'dist/swarm-id-auth.js',
      format: 'esm',
      sourcemap: true
    },
    onwarn,
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false,
        skip: ['tty', 'util', 'os', 'stream', 'path', 'http', 'https', 'url',
               'fs', 'assert', 'zlib', 'events', 'net', 'tls', 'crypto', 'buffer']
      }),
      commonjs(),
      json(),
      createTypeScriptPlugin(),
      production && terser()
    ],
    external: []
  }
]
