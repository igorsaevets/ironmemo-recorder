// Run src/shared/webm-seekable.js on a file from disk (Node 20+): node webm_seekable_cli.mjs <in.webm> <out.webm>
// Prints the module's summary as JSON; the output is streamed, so a long recording is never held whole.
// The checks themselves are in webm_seekable_cases.mjs.
import { openAsBlob, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { makeWebmSeekable } from '../apps/extension-audio/src/shared/webm-seekable.js';

const [input, output] = process.argv.slice(2);
const t0 = performance.now();
const res = await makeWebmSeekable(await openAsBlob(input));
await pipeline(Readable.fromWeb(res.blob.stream()), createWriteStream(output));
const { blob, ...summary } = res;
console.log(JSON.stringify({ ...summary, inBytes: (await openAsBlob(input)).size, outBytes: blob.size,
                             ms: Math.round(performance.now() - t0) }));
