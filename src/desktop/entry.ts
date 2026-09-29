// The packaged self-check is explicit and uses only a new, isolated directory.
const smoke = process.argv.find(argument => argument.startsWith('--ediro-release-smoke='));
if (smoke) {
  const { runReleaseSmoke } = await import('./release-smoke.js');
  await runReleaseSmoke(smoke.slice('--ediro-release-smoke='.length));
} else {
  await import('./main.js');
}
export {};
