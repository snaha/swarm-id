import typescript from '@rollup/plugin-typescript'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'

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
      resolve(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
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
    plugins: [
      resolve(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json'
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
      resolve(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json'
      }),
      production && terser()
    ],
    external: []
  }
]
