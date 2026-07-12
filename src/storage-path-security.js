import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = fs.realpathSync(path.resolve(moduleDirectory, '..'));

function comparablePath(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(leftPath, rightPath) {
  return comparablePath(leftPath) === comparablePath(rightPath);
}

function isSameOrDescendant(parentPath, candidatePath) {
  const parent = comparablePath(parentPath);
  const candidate = comparablePath(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalizePotentialPath(targetPath, label) {
  const absolutePath = path.resolve(targetPath);
  const targetStats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (targetStats?.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link.`);
  }

  let existingAncestor = absolutePath;
  const missingSegments = [];
  while (!fs.lstatSync(existingAncestor, { throwIfNoEntry: false })) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`${label} does not have an accessible filesystem ancestor.`);
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalAncestor = fs.realpathSync(existingAncestor);
  return path.resolve(canonicalAncestor, ...missingSegments);
}

export function normalizeAndValidateStorageConfiguration(config) {
  const uploadRoot = canonicalizePotentialPath(config.uploadRoot, 'UPLOAD_ROOT');
  const databasePath = canonicalizePotentialPath(config.dbPath, 'DB_PATH');
  const databaseDirectory = path.dirname(databasePath);
  const uploadFilesystemRoot = path.parse(uploadRoot).root;
  const databaseFilesystemRoot = path.parse(databaseDirectory).root;
  const protectedDirectories = [
    path.join(projectRoot, '.git'),
    path.join(projectRoot, 'public'),
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'views')
  ].map((directoryPath) => canonicalizePotentialPath(directoryPath, 'A protected project path'));

  if (isSamePath(uploadRoot, uploadFilesystemRoot) || isSameOrDescendant(uploadRoot, projectRoot)) {
    throw new Error('UPLOAD_ROOT cannot be a filesystem root, the project root, or a parent of the project.');
  }
  if (isSamePath(databaseDirectory, databaseFilesystemRoot)
    || isSameOrDescendant(databaseDirectory, projectRoot)) {
    throw new Error('DB_PATH cannot use a filesystem root, the project root, or a parent of the project as its directory.');
  }

  for (const protectedDirectory of protectedDirectories) {
    if (isSameOrDescendant(protectedDirectory, uploadRoot)) {
      throw new Error('UPLOAD_ROOT cannot be inside a source, static, view, or Git metadata directory.');
    }
    if (isSameOrDescendant(protectedDirectory, databasePath)) {
      throw new Error('DB_PATH cannot be inside a source, static, view, or Git metadata directory.');
    }
  }

  if (isSameOrDescendant(uploadRoot, databasePath)) {
    throw new Error('DB_PATH cannot be inside UPLOAD_ROOT because repository deletion could remove the database.');
  }

  config.uploadRoot = uploadRoot;
  config.dbPath = databasePath;
  return config;
}
