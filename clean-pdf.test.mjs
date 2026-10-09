import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFString, StandardFonts } from 'pdf-lib';
import { cleanPdf } from './clean-pdf.mjs';

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
