export const ARCHIVE_PREVIEW_MAX_PATH_COMPONENTS = 64;
export const ARCHIVE_PREVIEW_MAX_TREE_NODES = 10_000;

const UNSAFE_ARCHIVE_METADATA = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function normalizeArchivePreviewName(value, options = {}) {
  const maximumComponents = Number.isSafeInteger(Number(options.maximumComponents))
    ? Math.max(1, Number(options.maximumComponents))
    : ARCHIVE_PREVIEW_MAX_PATH_COMPONENTS;
  const normalized = String(value || '')
    .normalize('NFC')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');
  if (!normalized || UNSAFE_ARCHIVE_METADATA.test(normalized)) return null;

  const directory = normalized.endsWith('/');
  const components = normalized.split('/').filter(Boolean);
  if (
    components.length === 0
    || components.length > maximumComponents
    || components.some((component) => component === '.' || component === '..')
  ) {
    return null;
  }
  return {
    name: `${components.join('/')}${directory ? '/' : ''}`,
    components,
    directory
  };
}

export function createArchivePreviewTreeBudget(maximumNodes = ARCHIVE_PREVIEW_MAX_TREE_NODES) {
  const limit = Number.isSafeInteger(Number(maximumNodes))
    ? Math.max(1, Number(maximumNodes))
    : ARCHIVE_PREVIEW_MAX_TREE_NODES;
  const prefixes = new Set();

  return {
    get size() {
      return prefixes.size;
    },

    reserve(components) {
      if (!Array.isArray(components) || components.length === 0) return false;
      const additions = [];
      let prefix = '';
      for (const component of components) {
        prefix = prefix ? `${prefix}/${component}` : component;
        if (!prefixes.has(prefix)) additions.push(prefix);
      }
      if (prefixes.size + additions.length > limit) return false;
      for (const addition of additions) prefixes.add(addition);
      return true;
    }
  };
}
