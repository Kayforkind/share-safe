#!/usr/bin/env node
/**
 * share-safe — strip hidden data from a PDF before you send it.
 *
 * Removes hidden data a PDF can carry beyond its visible pages:
 *  - document info: Title, Author, Subject, Keywords, Creator, Producer, dates
 *  - XMP metadata stream (catalog /Metadata)
 *  - embedded files (attachments) in the names tree
 *  - document-level JavaScript in the names tree
 *
 * It then re-opens the output and checks that none of these remain. If the
 * re-check fails, cleanPdf() throws and no bytes are returned.
 *
 * Not covered yet: per-page annotation authors, form field values, and image
 * EXIF inside the page content. Those are listed in the report as NOT CHECKED.
 *
 * Usage:
 *   share-safe in.pdf -o out.pdf [--report out.json] [--md out.md]
 *   share-safe in.pdf --dry-run [--md out.md]
 *   share-safe a.pdf b.pdf ... --out-dir clean/ [--md out.md]     # batch; same file names
 *   share-safe a.pdf b.pdf ... --dry-run [--md out.md]           # batch preview
 * Exit: 0 cleaned and verified (or dry run) · 1 verification failed · 2 usage or read error
 * (batch: the worst code across files)
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream } from 'pdf-lib';

const REMOVE_KEYS = ['Metadata', 'EmbeddedFiles', 'JavaScript', 'JS', 'AA', 'OpenAction', 'AF', 'EF'];
// /A is also used by structure attributes and font glyph maps. Only remove actions.
function hasAction(doc, dict) {
  const value = dict.get(PDFName.of('A'));
  const action = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return action instanceof PDFDict && action.get(PDFName.of('S')) instanceof PDFName;
}
const safeText = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/([\\|`*_\[\]])/g, '\\$1');
const MAX_BYTES = 25 * 1024 * 1024;
function checkBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new Error('PDF input must be bytes under 25 MiB');
}

function allDicts(doc) {
  const seen = new Set();
  const dicts = [];
  const stack = [doc.catalog, doc.getInfoDict(), ...doc.context.enumerateIndirectObjects().map(([, obj]) => obj)];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj || seen.has(obj)) continue;
    seen.add(obj);
    if (obj instanceof PDFStream) stack.push(obj.dict);
    if (obj instanceof PDFDict) {
      dicts.push(obj);
      for (const [, value] of obj.entries()) if (!(value instanceof PDFRef)) stack.push(value);
    }
    if (obj instanceof PDFArray) for (let i = 0; i < obj.size(); i++) if (!(obj.get(i) instanceof PDFRef)) stack.push(obj.get(i));
  }
  return dicts;
}

// pdf-lib serializes orphan objects too. Retain only the post-scrub reachable graph.
function pruneOrphans(doc) {
  const visited = new Set();
  const refs = new Set();
  const stack = [doc.context.trailerInfo.Root, doc.context.trailerInfo.Info];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj || visited.has(obj)) continue;
    visited.add(obj);
    if (obj instanceof PDFRef) {
      refs.add(obj.toString());
      const target = doc.context.lookup(obj);
      if (!target) throw new Error('verification failed: dangling PDF reference');
      stack.push(target);
    } else if (obj instanceof PDFStream) stack.push(obj.dict);
    else if (obj instanceof PDFDict) for (const [, value] of obj.entries()) stack.push(value);
    else if (obj instanceof PDFArray) for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
  }
  for (const [ref] of doc.context.enumerateIndirectObjects()) if (!refs.has(ref.toString())) doc.context.delete(ref);
}

function namesDict(doc) {
  const names = doc.catalog.get(PDFName.of('Names'));
  const resolved = names instanceof PDFRef ? doc.context.lookup(names) : names;
  return resolved instanceof PDFDict ? resolved : null;
}

/** Lists the keys present in names-tree entries we remove, for the report. */
function present(doc) {
  const found = { info: [], xmp: false, attachments: 0, javascript: 0 };
  const info = doc.getInfoDict();
  found.info = info.keys().map((k) => k.decodeText());
  found.activeContent = allDicts(doc).reduce((n, dict) => n + REMOVE_KEYS.filter((k) => dict.has(PDFName.of(k))).length + Number(hasAction(doc, dict)), 0);
  found.xmp = !!doc.catalog.get(PDFName.of('Metadata'));
  const names = namesDict(doc);
  if (names) {
    const ef = names.get(PDFName.of('EmbeddedFiles'));
    if (ef) found.attachments = countNameTree(doc, ef);
    if (names.get(PDFName.of('JavaScript'))) found.javascript = 1;
  }
  return found;
}

function countNameTree(doc, node, depth = 0, seen = new Set()) {
  if (depth > 50) throw new Error('attachment tree exceeds depth limit');
  const n = node instanceof PDFRef ? doc.context.lookup(node) : node;
  if (!(n instanceof PDFDict)) return 0;
  if (seen.has(n)) throw new Error('cyclic attachment tree');
  seen.add(n);
  let count = 0;
  const names = doc.context.lookup(n.get(PDFName.of('Names')));
  if (names instanceof PDFArray) count += Math.floor(names.size() / 2);
  const kids = doc.context.lookup(n.get(PDFName.of('Kids')));
  if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) count += countNameTree(doc, kids.get(i), depth + 1, seen);
  return count;
}

export async function cleanPdf(bytes) {
  checkBytes(bytes);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  const before = present(doc);

  const info = doc.getInfoDict();
  for (const k of info.keys()) info.delete(k);
  for (const dict of allDicts(doc)) {
    for (const k of REMOVE_KEYS) dict.delete(PDFName.of(k));
    if (hasAction(doc, dict)) dict.delete(PDFName.of('A'));
  }
  delete doc.context.trailerInfo.ID;
  pruneOrphans(doc);
  doc.catalog.delete(PDFName.of('Metadata'));
  const names = namesDict(doc);
  if (names) {
    names.delete(PDFName.of('EmbeddedFiles'));
    names.delete(PDFName.of('JavaScript'));
  }

  const out = await doc.save({ useObjectStreams: false });

  // verify on the bytes we are about to release
  const check = await PDFDocument.load(out, { updateMetadata: false });
  const after = present(check);
  const leftovers = [];
  if (after.info.length) leftovers.push(`info fields: ${after.info.join(', ')}`);
  if (after.xmp) leftovers.push('XMP metadata');
  if (after.attachments) leftovers.push(`${after.attachments} attachment(s)`);
  if (after.javascript) leftovers.push('JavaScript');
  if (after.activeContent) leftovers.push('active content or hidden-data references');
  if (leftovers.length) throw new Error(`verification failed, output not released: ${leftovers.join('; ')}`);

  return {
    bytes: out,
    report: {
      removed: before,
      verified: true,
      notChecked: ['annotation authors', 'form field values', 'EXIF inside page images'],
    },
  };
}

/** What a cleaner would remove, without changing anything. Used by --dry-run. */
export async function inspectPdf(bytes) {
  checkBytes(bytes);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  return { removed: present(doc), notChecked: ['annotation authors', 'form field values', 'EXIF inside page images'] };
}

export function toMarkdown(report, { dryRun }) {
  const r = report.removed;
  const rows = [
    ['Document info', r.info.length ? r.info.join(', ') : 'none'],
    ['XMP metadata', r.xmp ? 'present' : 'none'],
    ['Embedded attachments', String(r.attachments)],
    ['JavaScript', r.javascript ? 'present' : 'none'],
    ['Active/hidden-content references', String(r.activeContent)],
  ];
  const lines = [
    `# share-safe ${dryRun ? 'dry run' : 'report'}`,
    '',
    '| Hidden data | Found |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${safeText(k)} | ${safeText(v)} |`),
    '',
    `**Selected removals verified:** ${dryRun ? 'not applicable (dry run)' : report.verified ? 'yes, re-opened and re-checked' : 'no'}`,
    '',
    '**Not checked (review manually):** ' + report.notChecked.join(', '),
    '',
  ];
  return lines.join('\n');
}

function setExit(code) {
  // Set, do not force-exit (forced exit can trip a libuv assertion on Windows).
  process.exitCode = code;
  return code;
}

const USAGE = [
  'usage: share-safe in.pdf -o out.pdf [--report out.json] [--md out.md]',
  '       share-safe in.pdf --dry-run [--md out.md]',
  '       share-safe a.pdf b.pdf ... --out-dir clean/ [--md out.md]',
  '       share-safe a.pdf b.pdf ... --dry-run [--md out.md]',
].join('\n');

const summaryLine = (r) => `info=[${r.info.map(safeText).join(', ') || '-'}] xmp=${r.xmp} attachments=${r.attachments} javascript=${r.javascript}`;

/** Clean or inspect one file. Returns an exit code and, on success, the Markdown section. */
async function processOne(input, values, batch) {
  const label = batch ? `${input}: ` : '';
  let bytes;
  try {
    if (!statSync(input).isFile() || statSync(input).size > MAX_BYTES) throw new Error('input must be a regular file under 25 MiB');
    bytes = new Uint8Array(readFileSync(input));
  } catch (e) {
    console.error(`cannot read ${input}: ${e.message}`);
    return { code: 2 };
  }

  if (values['dry-run']) {
    let report;
    try {
      report = await inspectPdf(bytes);
    } catch (e) {
      console.error(`${label}cannot read PDF: ${e.message}`);
      return { code: 2 };
    }
    console.log(`${label}would remove: ${summaryLine(report.removed)}`);
    console.log(`${label}not checked: ${report.notChecked.join(', ')}`);
    return { code: 0, md: toMarkdown(report, { dryRun: true }) };
  }

  const outPath = values['out-dir'] ? join(values['out-dir'], basename(input)) : values.o;
  if (resolve(outPath) === resolve(input)) {
    console.error(`${label}refusing to overwrite the input file`);
    return { code: 2 };
  }
  let result;
  try {
    result = await cleanPdf(bytes);
  } catch (e) {
    console.error(`${label}cannot clean: ${e.message}`);
    return { code: e.message.startsWith('verification') ? 1 : 2 };
  }
  writeFileSync(outPath, result.bytes, { flag: 'wx', mode: 0o600 });
  console.log(`${label}cleaned: ${summaryLine(result.report.removed)}`);
  console.log(`${label}not checked: ${result.report.notChecked.join(', ')}`);
  return { code: 0, md: toMarkdown(result.report, { dryRun: false }), report: result.report };
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      o: { type: 'string', short: 'o' },
      'out-dir': { type: 'string' },
      report: { type: 'string' },
      md: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const inputs = positionals;
  const batch = inputs.length > 1 || values['out-dir'] !== undefined;
  if (values.help || inputs.length === 0 || (!values.o && !values['dry-run'] && !values['out-dir'])) {
    console.log(USAGE);
    return setExit(values.help ? 0 : 2);
  }
  if (values.o && batch) {
    console.error('-o takes one input; use --out-dir for several');
    return setExit(2);
  }
  if (values['out-dir'] && values['dry-run']) {
    console.error('--out-dir and --dry-run cannot be combined');
    return setExit(2);
  }
  if (batch && values.report) {
    console.error('--report is for a single file; use --md for a batch summary');
    return setExit(2);
  }
  if (values['dry-run'] && values.o) throw new Error('-o and --dry-run cannot be combined');
  const canonicalTarget = (p) => {
    const abs = resolve(p);
    if (existsSync(abs)) return realpathSync(abs);
    // Catch symlinked parent directories even for not-yet-created files.
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalTarget(parent), basename(abs));
  };
  const inputPaths = inputs.map(canonicalTarget);
  const outputPaths = [values.report, values.md, ...(!values['dry-run'] ? inputs.map((input) => values['out-dir'] ? join(values['out-dir'], basename(input)) : values.o) : [])].filter(Boolean);
  const targets = outputPaths.map(canonicalTarget);
  const normalized = targets.map((p) => process.platform === 'win32' ? p.toLowerCase() : p);
  if (targets.some((p) => inputPaths.includes(p))) throw new Error('refusing to overwrite the input file');
  if (new Set(normalized).size !== normalized.length) throw new Error('output paths collide (including duplicate batch filenames)');
  for (const p of outputPaths) {
    try { lstatSync(p); throw new Error('output already exists; refusing to overwrite'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (values['out-dir']) mkdirSync(values['out-dir'], { recursive: true });

  const mdParts = [];
  let worst = 0;
  for (const input of inputs) {
    const r = await processOne(input, values, batch);
    worst = Math.max(worst, r.code);
    if (r.md) mdParts.push(r.md);
    if (r.report && values.report) writeFileSync(values.report, JSON.stringify(r.report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (values.md && mdParts.length) writeFileSync(values.md, mdParts.join('\n---\n\n'), { flag: 'wx', mode: 0o600 });
  return setExit(worst);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // Unexpected errors and usage errors exit 2 with a one-line message, never a stack trace.
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    setExit(2);
  });
}
