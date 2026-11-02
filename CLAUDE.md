# Schurco PDF Editor

In-browser PDF editor (markups, page tools, redaction, crop, export) that never uploads files.

- **Work / personal:** Work (Schurco Slurry)
- **Port:** 8094
- **Start:** `python -m http.server 8094 --bind 127.0.0.1` (or the `schurco-pdf-editor` entry in `.claude\launch.json`), then open http://127.0.0.1:8094/
- **GitHub:** https://github.com/Lallix/schurco-pdf-editor (public — never commit secrets or sample documents)
- **Stack:** Static HTML / JavaScript ES modules PWA (no build step), pdf.js, pdf-lib, ExcelJS and docx bundled locally in `js\`
- **Non-code files:** `_files\` (create `docs\`, `data\`, `design\`, `archive\` as needed). Synced by OneDrive, gitignored.

## Rules
- Only work inside this folder. Never start another app's server.
- Use relative paths only. This folder is opened on two PCs with different Windows usernames (`GideonV` and `lalli`).
