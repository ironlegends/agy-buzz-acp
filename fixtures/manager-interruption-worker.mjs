import { planInstall, applyInstall } from '../src/manage.js';

const [archive, sha256, root, harness] = process.argv.slice(2);
const plan = await planInstall({ archive, sha256, root, harness });
const hold = setInterval(() => {}, 1_000);
try {
  await applyInstall(plan, {
    afterClaim: async ({ claimPath }) => {
      if (typeof process.send === 'function') process.send({ kind: 'claim', claimPath });
      await new Promise(() => {});
    }
  });
} catch (error) {
  if (typeof process.send === 'function') process.send({ kind: 'error', message: error.message });
  process.exitCode = 1;
} finally {
  clearInterval(hold);
}
