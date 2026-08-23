import type * as PdfJs from 'pdfjs-dist'

type PdfJsModule = typeof PdfJs

/**
 * PDF.js ships as native ESM. Loading its self-hosted display module directly
 * avoids Next 14 rewriting it as a Webpack module, which breaks in development.
 */
export async function loadPdfJs(assetsBase: string): Promise<PdfJsModule> {
  return import(
    /* webpackIgnore: true */
    `${assetsBase}/pdf.min.mjs`
  ) as Promise<PdfJsModule>
}
