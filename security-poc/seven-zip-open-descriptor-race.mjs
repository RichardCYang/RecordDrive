import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

function workerResult(source, workerData) {
  const worker = new Worker(source, {
    eval: true,
    workerData,
    trackUnmanagedFds: true
  });
  return new Promise((resolve, reject) => {
    worker.once('message', (message) => {
      void worker.terminate();
      resolve(message);
    });
    worker.once('error', reject);
  });
}

const VULNERABLE_WORKER = `
  const fs = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');
  const fd = fs.openSync(workerData.filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    if (stats.size !== workerData.expectedSize) throw new Error('size changed');
    const output = Buffer.alloc(stats.size);
    fs.readSync(fd, output, 0, output.length, 0);
    parentPort.postMessage(output.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
`;

const FIXED_WORKER = `
  const fs = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');
  const stats = fs.fstatSync(workerData.fileDescriptor);
  if (stats.size !== workerData.expectedSize) throw new Error('size changed');
  const output = Buffer.alloc(stats.size);
  fs.readSync(workerData.fileDescriptor, output, 0, output.length, 0);
  parentPort.postMessage(output.toString('utf8'));
`;

export async function runSevenZipOpenDescriptorRacePoc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-7z-race-'));
  const archivePath = path.join(root, 'stored.7z');
  const replacementPath = path.join(root, 'replacement.7z');
  const fixtureSize = 64;
  const authorizedBytes = 'AUTHORIZED-ARCHIVE-METADATA'.padEnd(fixtureSize, 'A');
  const replacementBytes = 'UNAUTHORIZED-LOCAL-CONTENT'.padEnd(fixtureSize, 'Z');

  fs.writeFileSync(archivePath, authorizedBytes, { mode: 0o600 });
  fs.writeFileSync(replacementPath, replacementBytes, { mode: 0o600 });
  const trustedFd = fs.openSync(archivePath, fs.constants.O_RDONLY);
  const expectedSize = fs.fstatSync(trustedFd).size;

  try {
    fs.renameSync(replacementPath, archivePath);
    const vulnerableRead = await workerResult(VULNERABLE_WORKER, {
      filePath: archivePath,
      expectedSize
    });
    const fixedRead = await workerResult(FIXED_WORKER, {
      fileDescriptor: trustedFd,
      expectedSize
    });
    const descriptorStillOpen = fs.fstatSync(trustedFd).isFile();

    return {
      expectedSize,
      vulnerableRead,
      fixedRead,
      vulnerableAcceptedReplacement: vulnerableRead === replacementBytes,
      fixedStayedOnAuthorizedInode: fixedRead === authorizedBytes,
      descriptorStillOpen
    };
  } finally {
    fs.closeSync(trustedFd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await runSevenZipOpenDescriptorRacePoc(), null, 2));
}
