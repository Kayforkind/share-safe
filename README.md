# share-safe

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
node clean-pdf.mjs contract.pdf --dry-run --md preview.md
```

```
would remove: info=[Title, Author, Creator, Producer, CreationDate, ModDate] xmp=false attachments=1 javascript=0
not checked: annotation authors, form field values, EXIF inside page images
```

Then clean:

```bash
node clean-pdf.mjs contract.pdf -o contract-share.pdf --report removed.json --md report.md
```

See [`examples/`](examples/) for a sample input, its dry-run preview, and the report it produces.

| Exit | Meaning |
| --- | --- |
| `0` | Cleaned and verified, or dry run finished |
| `1` | Verification failed: the output still had hidden data, so **nothing was written** |
| `2` | Usage or read error |

## What it removes

- **Document info:** Title, Author, Subject, Keywords, Creator, Producer, creation and modification dates
- **XMP metadata:** the catalog's metadata stream
- **Embedded files:** attachments in the names tree
- **Document JavaScript:** scripts in the names tree

After saving, it re-opens the output and checks each of these. If anything is left, it throws and does not release the file.

## What it does not check

These are listed in every report as **not checked**. Review them by hand:

- **Annotation authors** on comments and markup
- **Form field values** you may have filled in
- **EXIF and GPS data inside images** placed on the pages

Removing EXIF from embedded images would need a re-encode of each image. That is a planned feature, not a current one.

## Limits

- Cleaning changes the file. Digital signatures on the original are invalidated by any save. Sign the cleaned copy instead.
- pdf-lib writes its own `Producer` on save, so the output may show a generic producer after the cleaner runs.
- Encrypted PDFs need their password first. The cleaner does not try to open them.

## Development

```bash
npm test
```

## License

MIT
