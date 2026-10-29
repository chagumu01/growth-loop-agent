import { lstat, unlink, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export async function cleanupEvaluation({ sandbox, tempRoot, children, stop, closeFixture, remove = rm }) {
  const target = resolve(sandbox);
  if (dirname(target) !== resolve(tempRoot) || !basename(target).startsWith('growth-loop-eval-')) throw new Error('Unsafe cleanup target');
  for (const entry of children) stop(entry.child);
  await Promise.all(children.map(async entry => {
    let timer;
    try {
      await Promise.race([entry.completion.catch(() => {}), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for evaluation process shutdown')), 10000);
      })]);
    } finally { clearTimeout(timer); }
  }));
  if (closeFixture) await closeFixture();
  const dependencies = `${target}/node_modules`;
  const link = await lstat(dependencies).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (link?.isSymbolicLink()) await unlink(dependencies);
  await remove(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
