const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
async function verify(command, args) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args, {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL:
          'postgresql://synthetic:synthetic@127.0.0.1:1/kheleo_entrypoint?connect_timeout=1',
        REDIS_URL: '',
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '1',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }, 8000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const missingModule = /Cannot find module|MODULE_NOT_FOUND/.test(output);
      const dependencyError = /UnknownDependenciesException|Nest can't resolve/.test(output);
      const initialized =
        /AppModule dependencies initialized/.test(output) &&
        /OutboxDispatcher|RealtimeModule dependencies initialized/.test(output);
      if (missingModule || dependencyError || !initialized) {
        reject(
          new Error(
            `Entrypoint failed before infrastructure validation: ${command} ${args.join(' ')}`,
          ),
        );
        return;
      }
      resolve({
        command: [command, ...args].join(' '),
        code,
        signal,
        entrypointResolved: true,
        dependencyInjectionResolved: true,
        unavailableInfrastructureControl: /ECONNREFUSED|Can't reach database server/.test(output),
      });
    });
  });
}
(async () => {
  require.resolve('../dist/main');
  require.resolve('../dist/src/main.js');
  const results = [
    await verify(process.execPath, ['dist/main']),
    await verify('pnpm', ['start:prod']),
  ];
  const report = {
    verifiedAt: new Date().toISOString(),
    runtime: process.version,
    result: 'PASS',
    results,
    scope:
      'Entrypoint/module resolution only; native production boot is verified separately by smoke-production.cjs',
  };
  const targetPath = 'audit-evidence/2026-11-05/entrypoint-results.json';
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.writeFileSync(
    targetPath,
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch((error) => {
  process.stderr.write(String(error.stack ?? error) + '\n');
  process.exitCode = 1;
});
