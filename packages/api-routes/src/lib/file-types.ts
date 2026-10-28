// One table of the file types CloudChat accepts, shared by the upload routes,
// the chat (attachments) and the front end. The list follows what Cloudflare
// AI Search can index for folder files:
// https://developers.cloudflare.com/ai-search/configuration/data-source/
//
// The server decides the MIME type from the extension: browsers often report
// an empty or odd type for .md, code and config files.

// How a chat attachment reaches the model:
// - text:     read as UTF-8 and inlined as text
// - pdf:      sent as a file (OpenRouter's file-parser plugin reads it)
// - image:    sent as an image (vision models only)
// - document: converted to Markdown with Workers AI toMarkdown, then inlined
export type FileKind = "text" | "pdf" | "image" | "document";

const types = {
  // Plain text, markup and config
  txt: ["text/plain", "text"],
  rst: ["text/x-rst", "text"],
  log: ["text/plain", "text"],
  md: ["text/markdown", "text"],
  markdown: ["text/markdown", "text"],
  mdx: ["text/markdown", "text"],
  ini: ["text/plain", "text"],
  conf: ["text/plain", "text"],
  properties: ["text/plain", "text"],
  toml: ["text/toml", "text"],
  tex: ["application/x-tex", "text"],
  latex: ["application/x-latex", "text"],
  sgml: ["text/sgml", "text"],
  csv: ["text/csv", "text"],
  json: ["application/json", "text"],
  xml: ["application/xml", "text"],
  sql: ["application/sql", "text"],
  yaml: ["application/x-yaml", "text"],
  yml: ["application/x-yaml", "text"],
  // Scripts and code
  sh: ["application/x-sh", "text"],
  bat: ["application/x-msdos-batch", "text"],
  ps1: ["text/x-powershell", "text"],
  css: ["text/css", "text"],
  js: ["text/javascript", "text"],
  ts: ["text/x-typescript", "text"],
  tsx: ["text/x-typescript", "text"],
  php: ["application/x-httpd-php", "text"],
  py: ["text/x-python", "text"],
  rb: ["text/x-ruby", "text"],
  java: ["text/x-java-source", "text"],
  c: ["text/x-c", "text"],
  cpp: ["text/x-c++", "text"],
  cxx: ["text/x-c++", "text"],
  h: ["text/x-c-header", "text"],
  hpp: ["text/x-c-header", "text"],
  go: ["text/x-go", "text"],
  rs: ["text/rust", "text"],
  swift: ["text/swift", "text"],
  dart: ["text/dart", "text"],
  tf: ["text/plain", "text"],
  el: ["text/x-emacs-lisp", "text"],
  // PDF
  pdf: ["application/pdf", "pdf"],
  // Images
  jpg: ["image/jpeg", "image"],
  jpeg: ["image/jpeg", "image"],
  png: ["image/png", "image"],
  webp: ["image/webp", "image"],
  gif: ["image/gif", "image"],
  // Converted to Markdown (SVG and BMP aren't accepted by vision models directly)
  svg: ["image/svg+xml", "document"],
  bmp: ["image/bmp", "document"],
  html: ["text/html", "document"],
  htm: ["text/html", "document"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "document",
  ],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "document",
  ],
  xlsm: ["application/vnd.ms-excel.sheet.macroenabled.12", "document"],
  xlsb: ["application/vnd.ms-excel.sheet.binary.macroenabled.12", "document"],
  xls: ["application/vnd.ms-excel", "document"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet", "document"],
  odt: ["application/vnd.oasis.opendocument.text", "document"],
  numbers: ["application/vnd.apple.numbers", "document"],
} as const satisfies Record<string, readonly [string, FileKind]>;

export type FileExtension = keyof typeof types;

export interface FileType {
  extension: FileExtension;
  mimeType: string;
  kind: FileKind;
}

export const fileExtensions = Object.keys(types) as FileExtension[];

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx + 1).toLowerCase();
}

// Returns the file type for a filename, or null if CloudChat doesn't accept it.
export function fileTypeOf(filename: string): FileType | null {
  const extension = extensionOf(filename);
  if (!(extension in types)) return null;
  const [mimeType, kind] = types[extension as FileExtension];
  return { extension: extension as FileExtension, mimeType, kind };
}

// For an <input accept="..."> attribute.
export function acceptAttribute(kinds: readonly FileKind[]): string {
  return fileExtensions
    .filter((ext) => kinds.includes(types[ext][1]))
    .map((ext) => `.${ext}`)
    .join(",");
}
