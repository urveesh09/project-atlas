import { extractFileFacts } from '@atlas/analyzer-ts';
import { extractPythonFacts, failedPythonFacts, initPythonParser, isPythonSourcePath } from '@atlas/analyzer-py';

/**
 * Parser child process (plan §15.3, ADR-058): owns every syntax tree and returns plain facts
 * over IPC, for TS/JS and Python alike. It holds nothing between files, never reads files or
 * opens sockets, and is killed by its parent on deadline or memory limits. The Python
 * grammar is loaded once, before the child reports ready.
 */
interface ParseRequest {
  type: 'parse';
  id: number;
  path: string;
  text: string;
}

if (typeof process.send !== 'function') {
  throw new Error('parse-worker must be started with an IPC channel');
}

await initPythonParser();

process.on('message', (message: ParseRequest) => {
  if (message?.type !== 'parse') return;
  try {
    let facts;
    if (isPythonSourcePath(message.path)) {
      try {
        facts = extractPythonFacts(message.path, message.text);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        facts = failedPythonFacts(message.text, 'PARSER_STACK_LIMIT');
      }
    } else facts = extractFileFacts(message.path, message.text);
    process.send!({ type: 'result', id: message.id, facts });
  } catch (error) {
    process.send!({ type: 'error', id: message.id, message: error instanceof Error ? error.name : 'Error' });
  }
});

process.send({ type: 'ready' });
