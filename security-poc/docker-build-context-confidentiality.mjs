import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VULNERABLE_DOCKERIGNORE = `node_modules
npm-debug.log*
.env
data/*.db
data/*.db-*
data/uploads/*
.git
.gitignore
`;

const VULNERABLE_DOCKERFILE = `FROM node:24.18.0-alpine
WORKDIR /app
COPY --chown=node:node package*.json ./
COPY --chown=node:node vendor/xz-compat-purejs ./vendor/xz-compat-purejs
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node . .
`;

export const CONFIDENTIALITY_CANARIES = Object.freeze([
  '.env.production',
  '.env.local',
  'certificates/tls-private.key',
  'certificates/recorddrive.pfx',
  'data/recorddrive-backup.sqlite',
  'data/exports/tenant-a.zip',
  'logs/recorddrive.log',
  '.git/config'
]);

function normalizeProjectPath(value) {
  return String(value || '')
    .replaceAll('\\\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function baselinePatternIgnores(candidate, pattern) {
  const normalized = normalizeProjectPath(candidate);
  const rule = normalizeProjectPath(pattern);

  if (!rule || rule.startsWith('#') || rule.startsWith('!')) return false;
  if (rule === '.git') return normalized === '.git' || normalized.startsWith('.git/');
  if (rule === '.gitignore' || rule === '.env' || rule === 'node_modules') {
    return normalized === rule || normalized.startsWith(`${rule}/`);
  }
  if (rule === 'npm-debug.log*') return /^npm-debug\.log.*$/.test(path.posix.basename(normalized));
  if (rule === 'data/*.db') return /^data\/[^/]+\.db$/.test(normalized);
  if (rule === 'data/*.db-*') return /^data\/[^/]+\.db-[^/]+$/.test(normalized);
  if (rule === 'data/uploads/*') return normalized.startsWith('data/uploads/');
  return false;
}

export function isIgnoredByVulnerablePolicy(candidate, dockerignore = VULNERABLE_DOCKERIGNORE) {
  return dockerignore
    .split(/\r?\n/)
    .some((pattern) => baselinePatternIgnores(candidate, pattern));
}

function tokenizeCopyInstruction(line) {
  const trimmed = line.trim();
  if (!/^(?:COPY|ADD)\s+/i.test(trimmed)) return null;

  const body = trimmed.replace(/^(?:COPY|ADD)\s+/i, '');
  if (body.startsWith('[')) {
    try {
      const values = JSON.parse(body);
      return Array.isArray(values) && values.length >= 2
        ? { sources: values.slice(0, -1).map(normalizeProjectPath), destination: values.at(-1) }
        : null;
    } catch {
      return { malformed: true, sources: [], destination: '' };
    }
  }

  const tokens = body.split(/\s+/).filter(Boolean);
  while (tokens[0]?.startsWith('--')) tokens.shift();
  if (tokens.length < 2) return { malformed: true, sources: [], destination: '' };
  return {
    sources: tokens.slice(0, -1).map(normalizeProjectPath),
    destination: tokens.at(-1)
  };
}

export function parseCopySources(dockerfile) {
  const instructions = [];
  for (const rawLine of String(dockerfile || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    const parsed = tokenizeCopyInstruction(line);
    if (parsed) instructions.push(parsed);
  }
  return instructions;
}

export function hasBroadContextCopy(dockerfile) {
  return parseCopySources(dockerfile).some(({ sources }) =>
    sources.some((source) => source === '.' || source === '')
  );
}

function copiedBySource(candidate, source) {
  const normalizedCandidate = normalizeProjectPath(candidate);
  const normalizedSource = normalizeProjectPath(source);
  if (normalizedSource === '.' || normalizedSource === '') return true;
  if (normalizedSource === 'package*.json') {
    return /^package(?:-lock)?\.json$/.test(normalizedCandidate);
  }
  return normalizedCandidate === normalizedSource || normalizedCandidate.startsWith(`${normalizedSource}/`);
}

export function exposedCanaries({ dockerfile, dockerignore, canaries = CONFIDENTIALITY_CANARIES }) {
  const sources = parseCopySources(dockerfile).flatMap(({ sources: values }) => values);
  return canaries.filter((candidate) => {
    const copied = sources.some((source) => copiedBySource(candidate, source));
    if (!copied) return false;
    if (dockerfile === VULNERABLE_DOCKERFILE) {
      return !isIgnoredByVulnerablePolicy(candidate, dockerignore);
    }
    return true;
  });
}

function allowedDockerignoreRules(dockerignore) {
  return String(dockerignore || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('!'));
}

export function verifyPatchedPolicy({ dockerfile, dockerignore }) {
  const parsed = parseCopySources(dockerfile);
  const sources = parsed.flatMap(({ sources }) => sources);
  const malformedCopyInstruction = parsed.some(({ malformed }) => malformed);
  const broadContextCopy = hasBroadContextCopy(dockerfile);
  const denyAllFirst = String(dockerignore || '').split(/\r?\n/).find((line) => line.trim())?.trim() === '**';
  const allowRules = allowedDockerignoreRules(dockerignore);
  const expectedSources = new Set(['package.json', 'package-lock.json', 'vendor/xz-compat-purejs', 'src', 'public', 'views']);
  const unexpectedCopySources = sources.filter((source) => !expectedSources.has(source));
  const canaryExposure = exposedCanaries({ dockerfile, dockerignore });

  return {
    malformedCopyInstruction,
    broadContextCopy,
    denyAllFirst,
    allowRules,
    copySources: sources,
    unexpectedCopySources,
    exposedCanaries: canaryExposure,
    blockedCanaryCount: CONFIDENTIALITY_CANARIES.length - canaryExposure.length,
    verdict: !malformedCopyInstruction
      && !broadContextCopy
      && denyAllFirst
      && unexpectedCopySources.length === 0
      && canaryExposure.length === 0
      ? 'BLOCKED'
      : 'EXPOSED'
  };
}

export function runDockerBuildContextPoC(projectRoot = path.resolve('.')) {
  const patchedDockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile'), 'utf8');
  const patchedDockerignore = fs.readFileSync(path.join(projectRoot, '.dockerignore'), 'utf8');

  const baselineExposed = exposedCanaries({
    dockerfile: VULNERABLE_DOCKERFILE,
    dockerignore: VULNERABLE_DOCKERIGNORE
  });
  const patched = verifyPatchedPolicy({
    dockerfile: patchedDockerfile,
    dockerignore: patchedDockerignore
  });

  return {
    title: 'RecordDrive Docker build-context confidentiality PoC',
    confidentialityTarget: 'deployment secrets and backup artifacts inside the project build context',
    baseline: {
      broadContextCopy: hasBroadContextCopy(VULNERABLE_DOCKERFILE),
      exposedCanaries: baselineExposed,
      exposedCanaryCount: baselineExposed.length,
      verdict: baselineExposed.length > 0 ? 'EXPOSED' : 'BLOCKED'
    },
    patched
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const result = runDockerBuildContextPoC(path.resolve(process.argv[2] || '.'));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.baseline.verdict === 'EXPOSED' && result.patched.verdict === 'BLOCKED' ? 0 : 1;
}
