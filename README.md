# share-safe 1.1.2

> Remove selected PDF metadata and actions, then verify the saved output. Not complete anonymization or content redaction.

**Strip the hidden data from a PDF before you send it.**

A PDF can carry far more than its pages: an author name, the software that made it, edit dates, XMP metadata, file attachments, and JavaScript. share-safe removes those, re-opens the result to confirm they are gone, and writes a report of exactly what it did and what it could not check.

It runs entirely on your machine. Nothing is uploaded.

## Install

```bash
npm install
```

Requires Node 20+. The only dependency is `pdf-lib`.

## Usage

Preview first. A dry run changes nothing:

```bash
node clean-pdf.mjs examples/sample-dirty.pdf --dry-run --md preview.md
```

```
would remove: info=[Title, Author, Creator, Producer, CreationDate, ModDate] xmp=false attachments=1 javascript=0
not checked: annotation authors, form field values, EXIF inside page images
```

Then clean:

```bash
node clean-pdf.mjs examples/sample-dirty.pdf -o contract-share.pdf --report removed.json --md report.md
```

### Batch

Pass several files with `--out-dir`. Each cleaned file keeps its name, and the Markdown report has one section per file:

```bash
node clean-pdf.mjs contracts/*.pdf --out-dir contracts-clean --md batch.md
node clean-pdf.mjs contracts/*.pdf --dry-run --md preview.md
```

The tool refuses to overwrite any existing output or input, including aliases and report paths. Duplicate batch filenames and collisions between output/report paths are rejected before processing. Choose a new output folder for each run. A batch exits with the worst code of any file; successful earlier files remain if a later file fails.

See [`examples/`](examples/) for a sample input, its dry-run preview, and the report it produces.

| Exit | Meaning |
| --- | --- |
| `0` | Cleaned and verified, or dry run finished |
| `1` | Verification failed: the output still had hidden data, so **nothing was written** |
| `2` | Usage or read error |

## What it removes

- **Document info:** all keys, including custom fields; trailer document identifiers
- **XMP metadata:** metadata references in dictionaries throughout the PDF
- **Embedded files:** names-tree attachments, associated-file and embedded-file references
- **Active actions:** JavaScript, open/additional actions and action references throughout dictionaries (including link actions). `/A` is removed only when it resolves to an action dictionary; legitimate structure attributes and font glyph mappings are preserved.
- **Orphan objects:** objects no longer reachable after removal, so detached attachment/script payload objects are not serialized into the cleaned file

After saving, it re-opens the output and checks each of these. If anything is left, it throws and does not release the file.

## What it does not check

These are listed in every report as **not checked**. Review them by hand:

- **Annotation authors** on comments and markup
- **Form field values** you may have filled in
- **EXIF and GPS data inside images** placed on the pages

Removing EXIF from embedded images would need a re-encode of each image. That is a planned feature, not a current one.

## Limits

- Cleaning changes the file. Digital signatures on the original are invalidated by any save. Sign the cleaned copy instead.
- Action removal disables interactive links and action-driven behavior. Save invalidates signatures; verify the visible pages and expected behavior before sending.
- Inputs are limited to regular PDFs under 25 MiB. This is not a parser sandbox; hostile compressed PDFs still need OS memory/time limits.
- `verified` means the listed removals were rechecked, not malware clearance, complete anonymization or content redaction. Visible text, forms, annotation contents, rich media and image payloads can still disclose data.
- Encrypted PDFs need their password first. The cleaner does not try to open them.

## Development

```bash
npm test
```

## License

MIT

## Release verification

Use a supported Node LTS (22 or 24). Run `npm ci --ignore-scripts` followed by `npm run verify`. The security workflow runs the regression suite on Linux and Windows; it has not yet been executed remotely for this local change. New report/output files are created exclusively; choose fresh filenames or output folders for repeat runs. See [SECURITY.md](SECURITY.md) for the threat model and disclosure guidance.
