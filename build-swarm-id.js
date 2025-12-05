#!/usr/bin/env node

/**
 * Build script for Swarm ID app (swarm-id.snaha.net)
 *
 * - Copies SvelteKit build
 * - Copies library dist files
 * - Outputs to swarm-id-build/ directory
 */

import { mkdirSync, cpSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

console.log('Building Swarm ID App...')

// Create output directory
const outputDir = join(__dirname, 'swarm-id-build')
mkdirSync(outputDir, { recursive: true })

// Copy SvelteKit build
console.log('Copying SvelteKit build...')
const svelteKitBuildDir = join(__dirname, 'swarm-ui', 'build')
cpSync(svelteKitBuildDir, outputDir, { recursive: true })
console.log('✓ SvelteKit build copied')

// Copy library dist files
console.log('Copying library files...')
const libDistDir = join(__dirname, 'lib', 'dist')
const outputLibDir = join(outputDir, 'lib')
mkdirSync(outputLibDir, { recursive: true })
cpSync(libDistDir, outputLibDir, { recursive: true })
console.log('✓ Library files copied')

console.log('')
console.log('Build complete! Output in swarm-id-build/')
