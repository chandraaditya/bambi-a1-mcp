import { readConfig, redact, publicStatus } from '../src/config.mjs';
import { createRuntime } from '../src/runtime.mjs';
const config = readConfig();
const runtime = createRuntime(config);
try {
  console.log(redact(await runtime.diagnose(process.argv.includes('--connect')), config));
  if (process.argv.includes('--lan')) console.log(redact(publicStatus(await runtime.status('lan')), config));
  if (process.argv.includes('--cloud')) {
    console.log(redact(await runtime.devices(), config));
    console.log(redact(publicStatus(await runtime.status('cloud')), config));
  }
} catch (error) { console.error(redact(error.message, config)); process.exitCode = 1; }
finally { await runtime.close(); }
