// Offline protocol fixture; never contacts a provider or modifies application data.
const fs = require('node:fs'),
  path = require('node:path'),
  url = require('node:url');
const trace = path.join(process.cwd(), 'lsp-events.jsonl');
const documents = new Map();
const write = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]),
  );
};
const result = (id, value) => write({ jsonrpc: '2.0', id, result: value });
const diagnostic = (uri) => {
  const doc = documents.get(uri);
  if (!process.argv.includes('--no-diagnostics'))
    write({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        version: doc.version,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 2,
            message: 'fixture diagnostic ' + doc.text.length,
          },
        ],
      },
    });
};
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
let buffer = Buffer.alloc(0),
  spawned;
function message(value) {
  fs.appendFileSync(trace, JSON.stringify(value) + '\n');
  const { method, params, id } = value;
  if (method === 'initialize') {
    if (process.argv.includes('--child')) {
      spawned = require('node:child_process').spawn(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        { stdio: 'ignore' },
      );
      fs.writeFileSync('lsp-child.pid', String(spawned.pid));
    }
    result(id, {
      capabilities: {
        textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
        positionEncoding: 'utf-16',
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        ...(process.argv.includes('--pull') ? { diagnosticProvider: {} } : {}),
      },
    });
    return;
  }
  if (method === 'initialized') {
    write({
      jsonrpc: '2.0',
      id: 'edit-request',
      method: 'workspace/applyEdit',
      params: { edit: { changes: {} } },
    });
    write({
      jsonrpc: '2.0',
      id: 'exec-request',
      method: 'workspace/executeCommand',
      params: { command: 'untrusted' },
    });
    return;
  }
  if (method === 'textDocument/didOpen') {
    documents.set(params.textDocument.uri, params.textDocument);
    diagnostic(params.textDocument.uri);
    return;
  }
  if (method === 'textDocument/didChange') {
    const doc = documents.get(params.textDocument.uri);
    doc.text = params.contentChanges[0].text;
    doc.version = params.textDocument.version;
    diagnostic(params.textDocument.uri);
    return;
  }
  if (method === 'textDocument/didClose') {
    documents.delete(params.textDocument.uri);
    return;
  }
  if (method === 'shutdown') {
    result(id, null);
    return;
  }
  if (method === 'exit') {
    if (!spawned) process.exit(0);
    return;
  }
  if (!method || id === undefined) return;
  if (process.argv.includes('--hang')) return;
  if (process.argv.includes('--bad-frame')) {
    process.stdout.write('Content-Length: 999999999\r\n\r\n');
    return;
  }
  const uri = params.textDocument.uri,
    doc = documents.get(uri);
  if (method === 'textDocument/hover')
    result(id, { contents: { kind: 'plaintext', value: 'fixture hover: ' + doc.text }, range });
  else if (method === 'textDocument/definition' || method === 'textDocument/references')
    result(id, [
      { uri, range },
      { uri: url.pathToFileURL(path.resolve('..', 'outside.txt')).href, range },
      { uri: url.pathToFileURL(path.resolve('.env')).href, range },
    ]);
  else if (method === 'textDocument/documentSymbol')
    result(id, [{ name: 'fixtureSymbol', kind: 12, range, selectionRange: range }]);
  else if (method === 'textDocument/diagnostic')
    result(id, { kind: 'full', items: [{ range, message: 'pull fixture' }] });
  else write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown fixture method' } });
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(
      buffer
        .subarray(0, end)
        .toString()
        .match(/Content-Length:\s*(\d+)/i)?.[1],
    );
    if (buffer.length < end + 4 + length) return;
    const value = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    message(value);
  }
});
process.stdin.on('end', () => {
  if (!spawned) process.exit(0);
});
