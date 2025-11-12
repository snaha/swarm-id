import typescript from '@rollup/plugin-typescript'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'
import json from '@rollup/plugin-json'

const production = !process.env.ROLLUP_WATCH

export default [
  // ESM build
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/swarm-id.esm.js',
      format: 'esm',
      sourcemap: true
    },
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
      typescript({
        tsconfig: './tsconfig.json',
        declaration: true,
        declarationDir: './dist',
        outDir: './dist',
        compilerOptions: {
          skipLibCheck: true,
          skipDefaultLibCheck: true
        }
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
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false,
        skip: ['tty', 'util', 'os', 'stream', 'path', 'http', 'https', 'url',
               'fs', 'assert', 'zlib', 'events', 'net', 'tls', 'crypto', 'buffer']
      }),
      commonjs(),
      json(),
      typescript({
        tsconfig: './tsconfig.json',
        compilerOptions: {
          skipLibCheck: true,
          skipDefaultLibCheck: true
        }
      }),
      production && terser()
    ],
    external: []
  },
  // Separate builds for each module (for tree-shaking)
  {
    input: {
      'swarm-id-client': 'src/swarm-id-client.ts',
      'swarm-id-proxy': 'src/swarm-id-proxy.ts',
      'swarm-id-auth': 'src/swarm-id-auth.ts'
    },
    output: {
      dir: 'dist',
      format: 'esm',
      sourcemap: true,
      entryFileNames: '[name].js'
    },
    plugins: [
      resolve({
        browser: true,
        preferBuiltins: false,
        skip: ['tty', 'util', 'os', 'stream', 'path', 'http', 'https', 'url',
               'fs', 'assert', 'zlib', 'events', 'net', 'tls', 'crypto', 'buffer']
      }),
      commonjs(),
      json(),
      typescript({
        tsconfig: './tsconfig.json',
        compilerOptions: {
          skipLibCheck: true,
          skipDefaultLibCheck: true
        }
      }),
      production && terser()
    ],
    external: []
  }
]
