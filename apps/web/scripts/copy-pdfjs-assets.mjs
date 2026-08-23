import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pdfjsRoot = resolve(webRoot, 'node_modules/pdfjs-dist')
const outputRoot = resolve(webRoot, 'public/pdfjs')

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })

cpSync(resolve(pdfjsRoot, 'build/pdf.worker.min.mjs'), resolve(outputRoot, 'pdf.worker.min.mjs'))
cpSync(resolve(pdfjsRoot, 'build/pdf.min.mjs'), resolve(outputRoot, 'pdf.min.mjs'))
cpSync(resolve(pdfjsRoot, 'cmaps'), resolve(outputRoot, 'cmaps'), { recursive: true })
cpSync(resolve(pdfjsRoot, 'standard_fonts'), resolve(outputRoot, 'standard_fonts'), { recursive: true })
cpSync(resolve(pdfjsRoot, 'wasm'), resolve(outputRoot, 'wasm'), { recursive: true })
