# Vendored libraries

Served from this site so the Content-Security-Policy (`script-src 'self'`) needs no change. Loaded only when someone downloads a report as PDF.

| File | Package | Licence |
|---|---|---|
| `html2canvas-1.4.1.min.js` | html2canvas 1.4.1 (npm) | MIT |
| `jspdf-2.5.2.umd.min.js` | jspdf 2.5.2 (npm, `dist/jspdf.umd.min.js`) | MIT |

To update, take the same file from the new version's npm package and change the name and the path in `public/js/pretest.js` (`PDF_LIBS`).
