// The browser client is served with NO build step (Issue #4 criterion 1) — it is plain HTML that
// the host reads off disk. This copies it next to the compiled output so `dist/` is a complete,
// runnable tree. It is a copy, not a transform: whatever is in src/web is what the browser gets.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'dist', 'src'), { recursive: true });
await cp(join(root, 'src', 'web'), join(root, 'dist', 'src', 'web'), { recursive: true });
console.log('copied src/web -> dist/src/web');
