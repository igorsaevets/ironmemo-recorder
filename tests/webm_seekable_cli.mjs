// Run src/shared/webm-seekable.js on a file from disk (Node 20+): node webm_seekable_cli.mjs <in.webm> <out.webm>
// Prints the module's summary as JSON. Used by .claude/scripts/test_webm_seekable.py.
import { openAsBlob } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { makeWebmSeekable } from '../apps/extension-audio/src/shared/webm-seekable.js';

const [input, output] = process.argv.slice(2);
const t0 = performance.now();
const res = await makeWebmSeekable(await openAsBlob(input));
await writeFile(output, Buffer.from(await res.blob.arrayBuffer()));
const { blob, ...summary } = res;
console.log(JSON.stringify({ ...summary, inBytes: (await openAsBlob(input)).size, outBytes: blob.size,
                             ms: Math.round(performance.now() - t0) }));
