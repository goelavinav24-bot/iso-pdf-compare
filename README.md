
# Isometric PDF Compare (Engineering vs AutoSpool)

A lightweight React web app to compare two isometric PDFs (Engineering vs AutoSpool) with **Side-by-Side**, **Overlay**, and **Pixel Diff** modes. Runs entirely in-browser using PDF.js; no server required.

## Features
- Upload Engineering & AutoSpool PDFs
- Side-by-side viewer with synced pan/zoom (optional)
- Overlay with adjustable alpha and manual alignment (dx/dy) + optional colorize top layer
- Pixel-level diff with threshold & noise cleanup
- Heuristic metadata extraction (Line No, Revision, Spec, Size, Service, Insulation, Test Pressure)
- Export overlay/diff as PNG

## Tech
- React + Vite
- pdfjs-dist (PDF.js) worker from CDN for simplicity
- lucide-react icons

## Local Run
```bash
npm install
npm run dev
```
Open http://localhost:5173

## Build
```bash
npm run build
```
Static files will be in `dist/`.

## Deploy (Vercel)
1. Push this repo to GitHub.
2. Go to https://vercel.com/new → Import the repo.
3. Framework preset: **Vite**
4. Build command: `npm run build` | Output directory: `dist`
5. Deploy → Your app will be live at a URL like `https://your-project.vercel.app`

> Note: For enterprise/internal networks, you can bundle the PDF.js worker locally; or pin the CDN version. For local bundling, set `GlobalWorkerOptions.workerSrc` to your hosted worker path.

## Privacy Note
All processing occurs in the browser. PDFs are not uploaded.
