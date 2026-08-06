/**
 * tee-runner.js — 运行 worker-daemon 并同时输出到控制台和日志文件
 * 避免 PowerShell Tee-Object 的 UTF-8 编码问题
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '..', 'daemon-worker.log');
const stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' });

const child = spawn(process.execPath, [path.join(__dirname, 'worker-daemon.js')], {
  stdio: ['inherit', 'pipe', 'pipe']
});

function tee(data, isErr) {
  const text = data.toString('utf8');
  stream.write(text);
  if (isErr) process.stderr.write(data);
  else process.stdout.write(data);
}

child.stdout.on('data', d => tee(d, false));
child.stderr.on('data', d => tee(d, true));

child.on('exit', code => {
  stream.end();
  process.exit(code);
});
