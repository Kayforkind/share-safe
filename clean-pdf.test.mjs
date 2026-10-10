import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFString, StandardFonts } from 'pdf-lib';
import { cleanPdf, inspectPdf, toMarkdown } from './clean-pdf.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'clean-pdf.mjs');

async function dirtyPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText('Visible text', { x: 20, y: 250, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  doc.setTitle('Secret draft');
  doc.setAuthor('Jane Doe');
  doc.setSubject('Internal');
  await doc.attach(new TextEncoder().encode('hidden attachment'), 'notes.txt', { mimeType: 'text/plain' });
  // document-level JavaScript in the names tree
  const js = doc.context.obj({ Names: [PDFString.of('init'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') })] });
  const names = doc.catalog.get(PDFName.of('Names'));
  const names2 = names instanceof PDFDict ? names : doc.context.obj({});
  names2.set(PDFName.of('JavaScript'), doc.context.register(js));
  doc.catalog.set(PDFName.of('Names'), doc.context.register(names2));
  return doc.save();
}

test('cleaning removes info fields, attachments and JavaScript and reports them', async () => {
  const { bytes, report } = await cleanPdf(await dirtyPdf());
  assert.equal(report.verified, true);
  assert.ok(report.removed.info.includes('Title'));
  assert.ok(report.removed.info.includes('Author'));
  assert.equal(report.removed.attachments, 1);
  assert.equal(report.removed.javascript, 1);

  const out = await PDFDocument.load(bytes);
  assert.equal(out.getTitle(), undefined);
  assert.equal(out.getAuthor(), undefined);
  assert.equal(out.getPageCount(), 1);
});

test('the cleaned output has no attachments left', async () => {
  const { bytes } = await cleanPdf(await dirtyPdf());
  const out = await PDFDocument.load(bytes);
  const names = out.catalog.get(PDFName.of('Names'));
  const has = names instanceof PDFDict && names.get(PDFName.of('EmbeddedFiles'));
  assert.ok(!has);
});

test('a PDF with no authored metadata reports no personal fields removed', async () => {
  // pdf-lib writes its own Producer/Creator on save; those are software names, not authorship.
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const { report } = await cleanPdf(await doc.save());
  for (const k of ['Title', 'Author', 'Subject', 'Keywords']) assert.ok(!report.removed.info.includes(k));
  assert.equal(report.removed.attachments, 0);
  assert.equal(report.removed.javascript, 0);
  assert.equal(report.verified, true);
});

test('scrubs custom info, page actions and orphan payload bytes, preserving visible text', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  page.drawText('KEEP-VISIBLE', { font });
  doc.getInfoDict().set(PDFName.of('CustomSecret'), PDFString.of('ORPHAN-SECRET'));
  const script = doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFString.of('ORPHAN-SCRIPT') }));
  page.node.set(PDFName.of('AA'), doc.context.obj({ O: script }));
  const orphan = doc.context.register(doc.context.obj({ Hidden: PDFString.of('ORPHAN-PAYLOAD') }));
  assert.ok(orphan);
  const result = await cleanPdf(await doc.save());
  const raw = Buffer.from(result.bytes).toString('latin1');
  for (const secret of ['ORPHAN-SECRET', 'ORPHAN-SCRIPT', 'ORPHAN-PAYLOAD']) assert.ok(!raw.includes(secret), secret);
  const output = await PDFDocument.load(result.bytes, { updateMetadata: false });
  assert.equal(output.getPageCount(), 1);
  assert.ok(!output.getPage(0).node.has(PDFName.of('AA')));
  assert.equal((await inspectPdf(result.bytes)).removed.activeContent, 0);
  assert.ok(result.report.removed.info.includes('CustomSecret'));
});

test('preserves structure attributes and glyph /A while removing actual actions', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const structure = doc.context.obj({ Type: 'StructElem', S: 'P', A: { O: 'Layout', Placement: 'Block' } });
  const glyph = doc.context.flateStream(Buffer.from('0 0 d0'));
  const font = doc.context.obj({ Type: 'Font', Subtype: 'Type3', CharProcs: { A: doc.context.register(glyph) } });
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: doc.context.register(font) } }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.obj({ K: [doc.context.register(structure)] }));
  page.node.set(PDFName.of('A'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
  const cleaned = await cleanPdf(await doc.save());
  const back = await PDFDocument.load(cleaned.bytes, { updateMetadata: false });
  assert.ok(!back.getPage(0).node.has(PDFName.of('A')));
  const root = back.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
  const element = back.context.lookup(root.get(PDFName.of('K')).get(0), PDFDict);
  assert.equal(element.lookup(PDFName.of('A'), PDFDict).get(PDFName.of('Placement')).toString(), '/Block');
  const resources = back.getPage(0).node.Resources();
  const savedFont = resources.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
  assert.ok(savedFont.lookup(PDFName.of('CharProcs'), PDFDict).has(PDFName.of('A')));
});

test('custom document-info names cannot inject report HTML or rows', async () => {
  const doc = await PDFDocument.create(); doc.addPage();
  doc.getInfoDict().set(PDFName.of('<img onerror=x>|\nrow'), PDFString.of('value'));
  const { report } = await cleanPdf(await doc.save());
  const markdown = toMarkdown(report, { dryRun: false });
  assert.ok(!markdown.includes('<img'));
  assert.ok(markdown.includes('\\|'));
});

test('rejects oversized inputs and cyclic attachment trees', async () => {
  await assert.rejects(cleanPdf(new Uint8Array(25 * 1024 * 1024 + 1)), /25 MiB/);
  const doc = await PDFDocument.create(); doc.addPage();
  const tree = doc.context.obj({}); const ref = doc.context.register(tree);
  tree.set(PDFName.of('Kids'), doc.context.obj([ref]));
  doc.catalog.set(PDFName.of('Names'), doc.context.obj({ EmbeddedFiles: ref }));
  await assert.rejects(cleanPdf(await doc.save()), /cyclic/);
});

test('CLI protects report collisions, duplicate basenames and existing hardlinked outputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'share-sec-'));
  const input = join(root, 'a.pdf'); writeFileSync(input, await dirtyPdf());
  const before = readFileSync(input);
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  assert.equal(run([input, '--dry-run', '--md', input]).status, 2);
  mkdirSync(join(root, 'other')); const other = join(root, 'other', 'a.pdf'); writeFileSync(other, before);
  assert.equal(run([input, other, '--out-dir', join(root, 'clean')]).status, 2);
  const alias = join(root, 'alias.pdf'); linkSync(input, alias);
  assert.equal(run([input, '-o', alias]).status, 2);
  assert.ok(readFileSync(input).equals(before));
});

test('CLI batch: cleans every file into --out-dir under the same name and writes one Markdown summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-safe-'));
  writeFileSync(join(dir, 'a.pdf'), await dirtyPdf());
  writeFileSync(join(dir, 'b.pdf'), await dirtyPdf());
  const out = join(dir, 'clean');
  const r = spawnSync(process.execPath, [CLI, join(dir, 'a.pdf'), join(dir, 'b.pdf'), '--out-dir', out, '--md', join(dir, 'batch.md')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(out, 'a.pdf')) && existsSync(join(out, 'b.pdf')));
  assert.equal((readFileSync(join(dir, 'batch.md'), 'utf8').match(/# share-safe report/g) || []).length, 2);
  assert.equal((await PDFDocument.load(readFileSync(join(out, 'b.pdf')))).getTitle(), undefined);
});

test('CLI batch: refuses to write over an input file, and leaves the input unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-safe-'));
  const input = join(dir, 'a.pdf');
  writeFileSync(input, await dirtyPdf());
  const before = readFileSync(input);
  const r = spawnSync(process.execPath, [CLI, input, '--out-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to overwrite the input file/);
  assert.ok(readFileSync(input).equals(before));
});

test('CLI: usage mistakes exit 2, and unexpected errors print one line without a stack trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-safe-'));
  const a = join(dir, 'a.pdf');
  writeFileSync(a, await dirtyPdf());
  assert.equal(spawnSync(process.execPath, [CLI, a, join(dir, 'b.pdf')], { encoding: 'utf8' }).status, 2);
  const oBatch = spawnSync(process.execPath, [CLI, a, a, '-o', join(dir, 'x.pdf')], { encoding: 'utf8' });
  assert.equal(oBatch.status, 2);
  assert.match(oBatch.stderr, /-o takes one input/);
  const bogus = spawnSync(process.execPath, [CLI, '--bogus'], { encoding: 'utf8' });
  assert.equal(bogus.status, 2);
  assert.ok(!bogus.stderr.includes('    at '));
});
