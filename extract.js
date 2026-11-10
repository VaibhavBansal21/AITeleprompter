// Turns an uploaded script file (.txt, .pdf, .docx) into plain text.
// The PDF and Word libraries are loaded from the CDN only when that file type is picked.
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';

export async function extractText(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'pdf') return pdfText(await file.arrayBuffer());
  if (extension === 'docx') return wordText(await file.arrayBuffer());
  if (extension === 'doc') throw new Error('Old .doc files are not supported. Save it as .docx or PDF.');
  return file.text();
}

async function pdfText(fileBytes) {
  const pdfjs = await import(`${PDFJS_URL}/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_URL}/pdf.worker.min.mjs`;
  const pdf = await pdfjs.getDocument({ data: fileBytes }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const content = await (await pdf.getPage(pageNumber)).getTextContent();
    // A PDF line end is only a visual wrap, not a sentence end, so it becomes a space.
    pages.push(content.items.map(item => item.str + (item.hasEOL ? ' ' : '')).join(''));
  }
  const text = pages.join('\n').trim();
  // ponytail: no OCR. Scanned PDFs are images; add OCR (tesseract.js) only if users need it.
  if (!text) throw new Error('No text found in this PDF. It may be a scan (image only).');
  return text;
}

async function wordText(fileBytes) {
  await loadScript(MAMMOTH_URL); // defines window.mammoth
  const result = await window.mammoth.extractRawText({ arrayBuffer: fileBytes });
  return result.value.trim();
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${url}"]`)) return resolve();
    const script = Object.assign(document.createElement('script'), { src: url, onload: resolve });
    script.onerror = () => reject(new Error('Could not load the Word reader. Check your internet connection.'));
    document.head.append(script);
  });
}
