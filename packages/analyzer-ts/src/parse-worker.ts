import { extractFileFacts } from './extract.js';

/**
 * Parser child process (plan §15.3): owns every AST, returns plain facts over IPC and
 * holds nothing between files. It is killed by its parent on deadline or memory limits;
 * it never reads files, opens sockets or receives anything but text from the parent.
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

process.on('message', (message: ParseRequest) => {
  if (message?.type !== 'parse') return;
  try {
    const facts = extractFileFacts(message.path, message.text);
    process.send!({ type: 'result', id: message.id, facts });
  } catch (error) {
    process.send!({ type: 'error', id: message.id, message: error instanceof Error ? error.name : 'Error' });
  }
});

process.send({ type: 'ready' });
