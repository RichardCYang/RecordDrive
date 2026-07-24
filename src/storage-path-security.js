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

  if (config.smbEnabled) {
    const containerShareRoot = String(config.smbContainerShareRoot || '').replace(/\/+$/, '');
    if (
      !containerShareRoot
      || containerShareRoot === '/'
      || !path.posix.isAbsolute(containerShareRoot)
      || path.posix.normalize(containerShareRoot) !== containerShareRoot
      || /[\u0000-\u001f\u007f]/.test(containerShareRoot)
    ) {
      throw new Error('SMB_CONTAINER_SHARE_ROOT must be a normalized absolute POSIX path.');
    }
    const smbShareRoot = canonicalizePotentialPath(config.smbShareRoot, 'SMB_SHARE_ROOT');
    const smbControlRoot = canonicalizePotentialPath(config.smbControlRoot, 'SMB_CONTROL_ROOT');
    const smbRoots = [
      ['SMB_SHARE_ROOT', smbShareRoot],
      ['SMB_CONTROL_ROOT', smbControlRoot]
    ];

    for (const [label, smbRoot] of smbRoots) {
      const filesystemRoot = path.parse(smbRoot).root;
      if (isSamePath(smbRoot, filesystemRoot) || isSameOrDescendant(smbRoot, projectRoot)) {
        throw new Error(`${label} cannot be a filesystem root, the project root, or a parent of the project.`);
      }
      for (const protectedDirectory of protectedDirectories) {
        if (isSameOrDescendant(protectedDirectory, smbRoot)) {
          throw new Error(`${label} cannot be inside a source, static, view, or Git metadata directory.`);
        }
      }
      if (isSameOrDescendant(smbRoot, databasePath)) {
        throw new Error(`DB_PATH cannot be inside ${label}.`);
      }
      if (isSameOrDescendant(smbRoot, uploadRoot) || isSameOrDescendant(uploadRoot, smbRoot)) {
        throw new Error(`${label} and UPLOAD_ROOT cannot contain one another.`);
      }
    }

    if (isSameOrDescendant(smbShareRoot, smbControlRoot)
      || isSameOrDescendant(smbControlRoot, smbShareRoot)) {
      throw new Error('SMB_SHARE_ROOT and SMB_CONTROL_ROOT cannot contain one another.');
    }

    config.smbShareRoot = smbShareRoot;
    config.smbControlRoot = smbControlRoot;
    config.smbContainerShareRoot = containerShareRoot;
  }

  config.uploadRoot = uploadRoot;
  config.dbPath = databasePath;
  return config;
}
