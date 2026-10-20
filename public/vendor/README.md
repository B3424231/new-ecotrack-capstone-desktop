# Bundled offline assets

Daily Logs loads these files from disk so startup, charts, PDF exports, and Excel
exports do not wait for public CDNs. The shared Manrope stylesheet also uses
local font files. These are copies of the assets previously requested by the
page; no application dependency versions or lockfiles were changed.

| Asset | Version | License |
| --- | --- | --- |
| Tailwind browser runtime | 3.4.17 | `tailwindcss-LICENSE.txt` |
| Chart.js UMD | 4.5.1 | `chartjs-LICENSE.txt` |
| jsPDF | 2.5.1 | `jspdf-LICENSE.txt` and embedded notices |
| jsPDF AutoTable | 3.8.2 | `jspdf-autotable-LICENSE.txt` and embedded notices |
| ExcelJS | 4.3.0 | `exceljs-LICENSE.txt` |
| Manrope, weights 300–800 | Google Fonts distribution | `manrope-OFL.txt` |

`assets.json` records the download URLs and SHA-256 checksums. Preserve the
upstream license notices when updating these files. Source-map references and
documentation links inside upstream bundles are not runtime dependencies.

The Tailwind runtime retains the current page's dynamic utility styling. Other
pages still choose their own script sources; bundling these files does not
replace their CDN references automatically.
