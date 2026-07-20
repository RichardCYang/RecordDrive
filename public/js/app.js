(() => {
  const i18n = document.querySelector('[data-client-i18n]')?.dataset || {};
  const message = (key, fallback, values = {}) => {
    const template = i18n[key] || fallback;
    return String(template).replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return Object.hasOwn(values, name) ? String(values[name]) : match;
    });
  };


  const formatTransferBytes = (bytes) => {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / (1024 ** exponent);
    return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
  };

  const transferProgress = (() => {
    const root = document.querySelector('[data-transfer-progress]');
    if (!root) return null;

    const title = root.querySelector('[data-transfer-title]');
    const detail = root.querySelector('[data-transfer-detail]');
    const track = root.querySelector('[data-transfer-track]');
    const bar = root.querySelector('[data-transfer-bar]');
    const percent = root.querySelector('[data-transfer-percent]');
    const bytes = root.querySelector('[data-transfer-bytes]');
    const action = root.querySelector('[data-transfer-action]');
    let actionHandler = null;
    let hideTimer = null;
    let busy = false;

    const clearHideTimer = () => {
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = null;
    };

    const hide = () => {
      clearHideTimer();
      root.hidden = true;
      root.dataset.state = 'idle';
      root.classList.remove('is-indeterminate');
    };

    const setAction = (label, handler, disabled = false) => {
      actionHandler = typeof handler === 'function' ? handler : null;
      action.disabled = disabled;
      action.setAttribute('aria-label', label);
      action.title = label;
    };

    const setIndeterminate = (enabled) => {
      root.classList.toggle('is-indeterminate', enabled);
      if (enabled) track.removeAttribute('aria-valuenow');
    };

    action.addEventListener('click', () => actionHandler?.());

    return {
      isBusy: () => busy,
      start({ kind, titleText, detailText = '', onCancel }) {
        if (busy) return false;
        clearHideTimer();
        busy = true;
        root.hidden = false;
        root.dataset.state = 'active';
        root.dataset.kind = kind === 'download' ? 'download' : 'upload';
        root.classList.remove('is-indeterminate');
        title.textContent = titleText;
        detail.textContent = detailText;
        bar.style.width = '0%';
        percent.textContent = '0%';
        bytes.textContent = '';
        track.setAttribute('aria-valuenow', '0');
        setAction(message('cancelTransfer', 'Cancel transfer'), onCancel);
        return true;
      },
      update(loaded, total) {
        const loadedBytes = Math.max(0, Number(loaded) || 0);
        const totalBytes = Math.max(0, Number(total) || 0);
        if (totalBytes > 0) {
          const progress = Math.min(100, Math.max(0, Math.round((loadedBytes / totalBytes) * 100)));
          setIndeterminate(false);
          bar.style.width = `${progress}%`;
          percent.textContent = `${progress}%`;
          bytes.textContent = message('transferBytes', '{{loaded}} of {{total}}', {
            loaded: formatTransferBytes(loadedBytes),
            total: formatTransferBytes(totalBytes)
          });
          track.setAttribute('aria-valuenow', String(progress));
        } else {
          setIndeterminate(true);
          percent.textContent = '…';
          bytes.textContent = message('transferBytesUnknown', '{{loaded}} transferred', {
            loaded: formatTransferBytes(loadedBytes)
          });
        }
      },
      processing(detailText) {
        setIndeterminate(true);
        detail.textContent = detailText;
        percent.textContent = '…';
        bytes.textContent = '';
        // Once the browser has handed off the full request body, aborting the XHR can
        // sever the connection while the server is still receiving or committing it.
        setAction(detailText, null, true);
      },
      complete(titleText, detailText = '') {
        busy = false;
        setIndeterminate(false);
        root.dataset.state = 'success';
        title.textContent = titleText;
        detail.textContent = detailText;
        bar.style.width = '100%';
        percent.textContent = '100%';
        bytes.textContent = '';
        track.setAttribute('aria-valuenow', '100');
        setAction(message('dismiss', 'Dismiss'), hide);
        hideTimer = window.setTimeout(hide, 2200);
      },
      fail(titleText, detailText = '') {
        busy = false;
        setIndeterminate(false);
        root.dataset.state = 'error';
        title.textContent = titleText;
        detail.textContent = detailText;
        bar.style.width = '100%';
        percent.textContent = '';
        bytes.textContent = '';
        track.removeAttribute('aria-valuenow');
        setAction(message('dismiss', 'Dismiss'), hide);
      },
      cancel(titleText) {
        busy = false;
        setIndeterminate(false);
        root.dataset.state = 'canceled';
        title.textContent = titleText;
        detail.textContent = '';
        bar.style.width = '0%';
        percent.textContent = '';
        bytes.textContent = '';
        track.removeAttribute('aria-valuenow');
        setAction(message('dismiss', 'Dismiss'), hide);
        hideTimer = window.setTimeout(hide, 1600);
      }
    };
  })();

  const passwordToggles = document.querySelectorAll('[data-password-toggle]');
  passwordToggles.forEach((button) => {
    button.addEventListener('click', () => {
      const wrapper = button.closest('.input-with-icon');
      const input = wrapper?.querySelector('[data-password-input]');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? message('hide', 'Hide') : message('show', 'Show');
      button.setAttribute('aria-label', show ? message('hidePassword', 'Hide password') : message('showPassword', 'Show password'));
    });
  });

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      const confirmation = form.dataset.confirm || message('confirmContinue', 'Do you want to continue?');
      if (!window.confirm(confirmation)) event.preventDefault();
    });
  });

  document.querySelectorAll('[data-flash-close]').forEach((button) => {
    button.addEventListener('click', () => button.closest('[data-flash]')?.remove());
  });

  const uploadForm = document.querySelector('[data-upload-form]');
  if (uploadForm) {
    const input = uploadForm.querySelector('[data-file-input]');
    const dropZone = uploadForm.querySelector('[data-drop-zone]');
    const selectedFiles = uploadForm.querySelector('[data-selected-files]');
    const submitRow = uploadForm.querySelector('[data-upload-submit]');
    const summary = uploadForm.querySelector('[data-upload-summary]');

    const formatBytes = (bytes) => {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const value = bytes / (1024 ** exponent);
      return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
    };

    const renderFiles = () => {
      const files = Array.from(input.files || []);
      selectedFiles.replaceChildren();
      if (!files.length) {
        selectedFiles.hidden = true;
        submitRow.hidden = true;
        return;
      }

      files.forEach((file) => {
        const row = document.createElement('div');
        row.className = 'selected-file-row';
        const name = document.createElement('strong');
        name.textContent = file.name;
        const size = document.createElement('span');
        size.textContent = formatBytes(file.size);
        row.append(name, size);
        selectedFiles.append(row);
      });

      const total = files.reduce((sum, file) => sum + file.size, 0);
      summary.textContent = `${files.length} ${files.length === 1 ? message('file', 'file') : message('files', 'files')} · ${formatBytes(total)}`;
      selectedFiles.hidden = false;
      submitRow.hidden = false;
    };

    input.addEventListener('change', renderFiles);
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.add('is-dragging');
      });
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.remove('is-dragging');
      });
    });
    dropZone.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files?.length) return;
      input.files = event.dataTransfer.files;
      renderFiles();
    });
    uploadForm.addEventListener('submit', (event) => {
      const files = Array.from(input.files || []);
      const button = uploadForm.querySelector('button[type="submit"]');
      if (!files.length || !transferProgress || typeof XMLHttpRequest === 'undefined' || typeof FormData === 'undefined') {
        if (button) {
          button.disabled = true;
          button.textContent = message('uploading', 'Uploading…');
        }
        return;
      }

      event.preventDefault();
      if (transferProgress.isBusy()) return;

      const xhr = new XMLHttpRequest();
      const formData = new FormData(uploadForm);
      const originalButtonText = button?.textContent || '';
      const displayName = files.length === 1 ? files[0].name : `${files.length} ${message('files', 'files')}`;
      const totalFileBytes = files.reduce((total, file) => total + file.size, 0);
      const started = transferProgress.start({
        kind: 'upload',
        titleText: message('uploadingFile', 'Uploading {{name}}', { name: displayName }),
        detailText: summary.textContent,
        onCancel: () => xhr.abort()
      });
      if (!started) return;

      if (button) {
        button.disabled = true;
        button.textContent = message('uploading', 'Uploading…');
      }
      input.disabled = true;
      dropZone.classList.add('is-disabled');
      dropZone.setAttribute('aria-disabled', 'true');

      const restoreForm = () => {
        if (button) {
          button.disabled = false;
          button.textContent = originalButtonText;
        }
        input.disabled = false;
        dropZone.classList.remove('is-disabled');
        dropZone.removeAttribute('aria-disabled');
      };

      xhr.open((uploadForm.method || 'post').toUpperCase(), uploadForm.action, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.upload.addEventListener('progress', (progressEvent) => {
        transferProgress.update(
          progressEvent.loaded,
          progressEvent.lengthComputable ? progressEvent.total : totalFileBytes
        );
      });
      xhr.upload.addEventListener('load', () => {
        transferProgress.processing(message('processingUpload', 'Processing uploaded files…'));
      });
      xhr.addEventListener('load', () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || '{}');
        } catch {
          payload = {};
        }

        if (xhr.status >= 200 && xhr.status < 300 && payload.redirectUrl) {
          transferProgress.complete(message('uploadComplete', 'Upload complete'), displayName);
          window.setTimeout(() => window.location.assign(payload.redirectUrl), 350);
          return;
        }

        restoreForm();
        const detailText = payload.error || message(
          'uploadFailedDetail',
          'The upload could not be completed. Please try again.'
        );
        transferProgress.fail(message('uploadFailed', 'Upload failed'), detailText);
        if (payload.loginUrl) window.setTimeout(() => window.location.assign(payload.loginUrl), 700);
      });
      xhr.addEventListener('error', () => {
        restoreForm();
        transferProgress.fail(
          message('uploadFailed', 'Upload failed'),
          message('uploadFailedDetail', 'The upload could not be completed. Please try again.')
        );
      });
      xhr.addEventListener('abort', () => {
        restoreForm();
        transferProgress.cancel(message('uploadCanceled', 'Upload canceled'));
      });
      xhr.send(formData);
    });
  }

  const explorer = document.querySelector('[data-file-explorer]');
  if (explorer) {
    const uploadDrawer = explorer.querySelector('[data-upload-drawer]');
    const uploadOpenButtons = explorer.querySelectorAll('[data-upload-open]');
    const uploadCloseButton = explorer.querySelector('[data-upload-close]');
    const folderDrawer = explorer.querySelector('[data-folder-drawer]');
    const folderOpenButtons = explorer.querySelectorAll('[data-folder-open]');
    const folderCloseButton = explorer.querySelector('[data-folder-close]');
    const folderItems = Array.from(explorer.querySelectorAll('[data-folder-item]'));
    const fileItems = Array.from(explorer.querySelectorAll('[data-file-item]'));
    const fileItemsContainer = explorer.querySelector('[data-file-items]');
    const listHeader = explorer.querySelector('[data-list-header]');
    const viewButtons = Array.from(explorer.querySelectorAll('[data-view-mode]'));
    const filterButtons = Array.from(explorer.querySelectorAll('[data-file-filter]'));
    const filterEmpty = explorer.querySelector('[data-filter-empty]');
    const visibleCount = explorer.querySelector('[data-visible-file-count]');
    const visibleItemLabel = explorer.querySelector('[data-visible-item-label]');
    const statusCount = explorer.querySelector('[data-status-count]');
    const statusItemLabel = explorer.querySelector('[data-status-item-label]');
    const categoryHeading = explorer.querySelector('[data-current-category]');
    const selectionLabel = explorer.querySelector('[data-selection-label]');
    const selectedDownload = explorer.querySelector('[data-selected-download]');
    const selectedDeleteForm = explorer.querySelector('[data-selected-delete-form]');
    const selectedDeleteButton = explorer.querySelector('[data-selected-delete]');
    const detailsPane = explorer.querySelector('[data-details-pane]');
    const detailsEmpty = explorer.querySelector('[data-details-empty]');
    const detailsContent = explorer.querySelector('[data-details-content]');
    const detailsClose = explorer.querySelector('[data-details-close]');
    const detailDownload = explorer.querySelector('[data-detail-download]');
    const detailDeleteForm = explorer.querySelector('[data-detail-delete-form]');
    const detailTabs = Array.from(explorer.querySelectorAll('[data-details-tab]'));
    const detailPanels = Array.from(explorer.querySelectorAll('[data-details-panel]'));
    const previewMessage = explorer.querySelector('[data-preview-message]');
    const previewContent = explorer.querySelector('[data-preview-content]');
    const explorerSearch = explorer.querySelector('[data-explorer-search]');
    const kindCodes = {
      image: 'IMG',
      video: 'VID',
      audio: 'AUD',
      archive: 'ZIP',
      sheet: 'XLS',
      slide: 'PPT',
      pdf: 'PDF',
      document: 'DOC',
      file: 'FILE'
    };
    let selectedItem = null;
    let previewController = null;
    let loadedPreviewKey = '';


    const filenameFromDisposition = (headerValue, fallbackName) => {
      const value = String(headerValue || '');
      const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
      if (encodedMatch) {
        try {
          return decodeURIComponent(encodedMatch[1]).replace(/[\/\\]/g, '_');
        } catch {
          // Fall through to the basic filename parameter.
        }
      }
      const quotedMatch = value.match(/filename="([^"]*)"/i);
      const plainMatch = value.match(/filename=([^;]+)/i);
      return String(quotedMatch?.[1] || plainMatch?.[1] || fallbackName || 'download')
        .trim()
        .replace(/[\/\\]/g, '_');
    };

    const startDownload = async (url, fallbackName = 'download') => {
      if (!url || !transferProgress || transferProgress.isBusy()) return;
      const controller = new AbortController();
      const started = transferProgress.start({
        kind: 'download',
        titleText: message('downloadingFile', 'Downloading {{name}}', { name: fallbackName }),
        detailText: message('preparingDownload', 'Preparing download…'),
        onCancel: () => controller.abort()
      });
      if (!started) return;

      try {
        const response = await window.fetch(url, {
          credentials: 'same-origin',
          signal: controller.signal,
          headers: {
            Accept: 'application/octet-stream, application/json;q=0.9',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });

        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) {
          let errorMessage = message(
            'downloadFailedDetail',
            'The download could not be completed. Please try again.'
          );
          if (contentType.includes('application/json')) {
            const payload = await response.json().catch(() => ({}));
            errorMessage = payload.error || errorMessage;
            if (payload.loginUrl) window.setTimeout(() => window.location.assign(payload.loginUrl), 700);
          }
          throw new Error(errorMessage);
        }

        const filename = filenameFromDisposition(
          response.headers.get('content-disposition'),
          fallbackName
        );
        const totalBytes = Number(response.headers.get('content-length')) || 0;
        if (!response.body || typeof response.body.getReader !== 'function') {
          transferProgress.processing(message('preparingDownload', 'Preparing download…'));
          window.location.assign(url);
          transferProgress.complete(message('downloadComplete', 'Download complete'), filename);
          return;
        }

        const reader = response.body.getReader();
        const chunks = [];
        let receivedBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedBytes += value.byteLength;
          transferProgress.update(receivedBytes, totalBytes);
        }

        const blob = new Blob(chunks, { type: contentType || 'application/octet-stream' });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
        transferProgress.complete(message('downloadComplete', 'Download complete'), filename);
      } catch (error) {
        if (error?.name === 'AbortError') {
          transferProgress.cancel(message('downloadCanceled', 'Download canceled'));
          return;
        }
        transferProgress.fail(
          message('downloadFailed', 'Download failed'),
          error?.message || message(
            'downloadFailedDetail',
            'The download could not be completed. Please try again.'
          )
        );
      }
    };

    const openUploadDrawer = () => {
      if (!uploadDrawer) return;
      if (folderDrawer) folderDrawer.hidden = true;
      uploadDrawer.hidden = false;
      uploadDrawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.setTimeout(() => uploadDrawer.querySelector('[data-drop-zone]')?.focus?.(), 180);
    };

    const closeUploadDrawer = () => {
      if (uploadDrawer) uploadDrawer.hidden = true;
    };

    const openFolderDrawer = () => {
      if (!folderDrawer) return;
      if (uploadDrawer) uploadDrawer.hidden = true;
      folderDrawer.hidden = false;
      folderDrawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.setTimeout(() => folderDrawer.querySelector('[data-folder-name-input]')?.focus(), 180);
    };

    const closeFolderDrawer = () => {
      if (folderDrawer) folderDrawer.hidden = true;
    };

    uploadOpenButtons.forEach((button) => button.addEventListener('click', openUploadDrawer));
    uploadCloseButton?.addEventListener('click', closeUploadDrawer);
    folderOpenButtons.forEach((button) => button.addEventListener('click', openFolderDrawer));
    folderCloseButton?.addEventListener('click', closeFolderDrawer);
    explorer.querySelector('[data-refresh-button]')?.addEventListener('click', () => window.location.reload());
    explorer.querySelector('[data-sort-select]')?.addEventListener('change', (event) => {
      event.currentTarget.closest('form')?.requestSubmit();
    });

    const updateView = (view) => {
      const selectedView = view === 'grid' ? 'grid' : 'list';
      if (fileItemsContainer) fileItemsContainer.dataset.view = selectedView;
      if (listHeader) listHeader.hidden = selectedView === 'grid';
      viewButtons.forEach((button) => {
        const active = button.dataset.viewMode === selectedView;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      try {
        window.localStorage.setItem('recorddrive-file-view', selectedView);
      } catch {
        // Keep the view mode for the current session when persistent storage is unavailable.
      }
    };

    let savedView = 'list';
    try {
      savedView = window.localStorage.getItem('recorddrive-file-view') || 'list';
    } catch {
      savedView = 'list';
    }
    updateView(savedView);
    viewButtons.forEach((button) => button.addEventListener('click', () => updateView(button.dataset.viewMode)));

    const setDetailsValue = (selector, value) => {
      const target = explorer.querySelector(selector);
      if (target) target.textContent = value || '—';
    };


    const formatPreviewBytes = (bytes) => {
      const value = Number(bytes || 0);
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
      const amount = value / (1024 ** exponent);
      return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
    };

    const columnLabel = (columnNumber) => {
      let value = Number(columnNumber);
      let label = '';
      while (value > 0) {
        value -= 1;
        label = String.fromCharCode(65 + (value % 26)) + label;
        value = Math.floor(value / 26);
      }
      return label || 'A';
    };

    const setDetailsTab = (tabName) => {
      const selectedTab = tabName === 'preview' ? 'preview' : 'details';
      detailTabs.forEach((button) => {
        const active = button.dataset.detailsTab === selectedTab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      detailPanels.forEach((panel) => {
        panel.hidden = panel.dataset.detailsPanel !== selectedTab;
      });
    };

    const showPreviewMessage = (text, detail = '', state = 'info') => {
      if (previewController) {
        previewController.abort();
        previewController = null;
      }
      if (previewContent) {
        previewContent.hidden = true;
        previewContent.replaceChildren();
      }
      if (!previewMessage) return;
      previewMessage.hidden = false;
      previewMessage.className = `explorer-preview-message is-${state}`;
      const badge = document.createElement('span');
      badge.className = 'explorer-preview-message-icon';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = state === 'loading' ? '...' : 'PREVIEW';
      const title = document.createElement('strong');
      title.textContent = text;
      previewMessage.replaceChildren(badge, title);
      if (detail) {
        const description = document.createElement('small');
        description.textContent = detail;
        previewMessage.append(description);
      }
    };

    const showPreviewContent = (content) => {
      if (!previewContent) return;
      if (previewMessage) previewMessage.hidden = true;
      previewContent.replaceChildren(content);
      previewContent.hidden = false;
    };

    const resetPreview = () => {
      loadedPreviewKey = '';
      showPreviewMessage(message('openPreview', 'Select the Preview tab to open this file.'));
    };

    const fetchPreviewJson = async (url, signal) => {
      const response = await window.fetch(url, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        throw new Error(payload?.error || message('previewFailed', 'The file preview could not be loaded.'));
      }
      return payload;
    };

    const safeColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '';
    const borderStyle = (style) => {
      if (style === 'dashed' || style === 'dashDot' || style === 'dashDotDot') return 'dashed';
      if (style === 'dotted' || style === 'hair') return 'dotted';
      if (style === 'double') return 'double';
      return 'solid';
    };
    const borderWidth = (style) => {
      if (style === 'medium' || style === 'mediumDashed' || style === 'mediumDashDot' || style === 'mediumDashDotDot') return '2px';
      if (style === 'thick' || style === 'double') return '3px';
      return '1px';
    };

    const applySpreadsheetCellStyle = (element, style = {}) => {
      if (style.bold) element.style.fontWeight = '700';
      if (style.italic) element.style.fontStyle = 'italic';
      if (style.underline) element.style.textDecoration = 'underline';
      if (Number.isFinite(style.fontSize)) element.style.fontSize = `${Math.max(8, Math.min(style.fontSize, 24))}px`;
      const fontColor = safeColor(style.fontColor);
      const fillColor = safeColor(style.fillColor);
      if (fontColor) element.style.color = fontColor;
      if (fillColor) element.style.backgroundColor = fillColor;
      if (['left', 'center', 'right', 'justify'].includes(style.horizontal)) element.style.textAlign = style.horizontal;
      if (['top', 'middle', 'bottom'].includes(style.vertical)) element.style.verticalAlign = style.vertical;
      if (style.wrapText) element.style.whiteSpace = 'normal';
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const definition = style.border?.[side];
        if (!definition?.style) continue;
        const color = safeColor(definition.color) || '#cbd5e1';
        element.style[`border${side[0].toUpperCase()}${side.slice(1)}`] = `${borderWidth(definition.style)} ${borderStyle(definition.style)} ${color}`;
      }
    };

    const spreadsheetMergeMap = (sheet) => {
      const starts = new Map();
      const covered = new Set();
      for (const merge of sheet.merges || []) {
        const startRow = Math.max(1, Number(merge.startRow || 1));
        const startColumn = Math.max(1, Number(merge.startColumn || 1));
        const endRow = Math.min(sheet.visibleRowCount, Number(merge.endRow || startRow));
        const endColumn = Math.min(sheet.visibleColumnCount, Number(merge.endColumn || startColumn));
        if (startRow > sheet.visibleRowCount || startColumn > sheet.visibleColumnCount) continue;
        starts.set(`${startRow}:${startColumn}`, {
          rowSpan: Math.max(1, endRow - startRow + 1),
          columnSpan: Math.max(1, endColumn - startColumn + 1)
        });
        for (let row = startRow; row <= endRow; row += 1) {
          for (let column = startColumn; column <= endColumn; column += 1) {
            if (row !== startRow || column !== startColumn) covered.add(`${row}:${column}`);
          }
        }
      }
      return { starts, covered };
    };

    const renderSpreadsheetPreview = (item, payload) => {
      const sheet = payload.sheet;
      const shell = document.createElement('div');
      shell.className = 'xlsx-preview-shell';

      const heading = document.createElement('div');
      heading.className = 'xlsx-preview-heading';
      const title = document.createElement('strong');
      title.textContent = sheet.name;
      const dimensions = document.createElement('span');
      dimensions.textContent = `${sheet.rowCount} × ${sheet.columnCount}`;
      heading.append(title, dimensions);
      shell.append(heading);

      const grid = document.createElement('div');
      grid.className = 'xlsx-preview-grid';
      const table = document.createElement('table');
      table.className = 'xlsx-preview-table';
      const columnGroup = document.createElement('colgroup');
      const rowHeaderColumn = document.createElement('col');
      rowHeaderColumn.style.width = '42px';
      columnGroup.append(rowHeaderColumn);
      for (let column = 1; column <= sheet.visibleColumnCount; column += 1) {
        const definition = document.createElement('col');
        const workbookWidth = Number(sheet.columnWidths?.[column - 1]);
        definition.style.width = Number.isFinite(workbookWidth)
          ? `${Math.max(72, Math.min(workbookWidth * 8, 360))}px`
          : '110px';
        columnGroup.append(definition);
      }
      table.append(columnGroup);

      const header = document.createElement('thead');
      const headerRow = document.createElement('tr');
      const corner = document.createElement('th');
      corner.className = 'xlsx-corner-cell';
      headerRow.append(corner);
      for (let column = 1; column <= sheet.visibleColumnCount; column += 1) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = columnLabel(column);
        headerRow.append(cell);
      }
      header.append(headerRow);
      table.append(header);

      const body = document.createElement('tbody');
      const merges = spreadsheetMergeMap(sheet);
      for (let rowNumber = 1; rowNumber <= sheet.visibleRowCount; rowNumber += 1) {
        const row = document.createElement('tr');
        const rowHeader = document.createElement('th');
        rowHeader.scope = 'row';
        rowHeader.textContent = String(rowNumber);
        row.append(rowHeader);
        const rowData = sheet.rows?.[rowNumber - 1] || [];
        for (let columnNumber = 1; columnNumber <= sheet.visibleColumnCount; columnNumber += 1) {
          const key = `${rowNumber}:${columnNumber}`;
          if (merges.covered.has(key)) continue;
          const cellData = rowData[columnNumber - 1] || { value: '', style: {} };
          const cell = document.createElement('td');
          cell.textContent = cellData.value || '';
          const merge = merges.starts.get(key);
          if (merge) {
            if (merge.rowSpan > 1) cell.rowSpan = merge.rowSpan;
            if (merge.columnSpan > 1) cell.colSpan = merge.columnSpan;
          }
          if (cellData.type === 2) cell.classList.add('is-number');
          applySpreadsheetCellStyle(cell, cellData.style);
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body);
      grid.append(table);
      shell.append(grid);

      if (sheet.truncatedRows || sheet.truncatedColumns) {
        const notice = document.createElement('p');
        notice.className = 'xlsx-preview-notice';
        notice.textContent = message(
          'spreadsheetTruncated',
          'Previewing the first {{rows}} rows and {{columns}} columns.',
          { rows: sheet.visibleRowCount, columns: sheet.visibleColumnCount }
        );
        shell.append(notice);
      }

      const tabs = document.createElement('div');
      tabs.className = 'xlsx-sheet-tabs';
      tabs.setAttribute('role', 'tablist');
      for (const sheetEntry of payload.sheets || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = sheetEntry.name;
        const active = sheetEntry.index === sheet.index;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.addEventListener('click', () => loadFilePreview(item, sheetEntry.index));
        tabs.append(button);
      }
      shell.append(tabs);
      return shell;
    };

    const buildArchiveTree = (entries) => {
      const root = { name: '', directory: true, children: new Map() };
      for (const entry of entries || []) {
        const parts = String(entry.name || '').split('/').filter(Boolean);
        if (!parts.length) continue;
        let parent = root;
        parts.forEach((part, index) => {
          const last = index === parts.length - 1;
          const directory = !last || Boolean(entry.directory);
          let node = parent.children.get(part);
          if (!node) {
            node = { name: part, directory, children: new Map() };
            parent.children.set(part, node);
          }
          if (directory) node.directory = true;
          if (last) Object.assign(node, entry, { name: part, directory, children: node.children || new Map() });
          parent = node;
        });
      }
      return root;
    };

    const renderArchiveNodes = (parentElement, parentNode, depth = 0) => {
      const collator = new Intl.Collator(document.documentElement.lang || undefined, { numeric: true, sensitivity: 'base' });
      const children = Array.from(parentNode.children.values()).sort((left, right) => {
        if (left.directory !== right.directory) return left.directory ? -1 : 1;
        return collator.compare(left.name, right.name);
      });
      for (const node of children) {
        if (node.directory) {
          const folder = document.createElement('details');
          folder.className = 'zip-preview-folder';
          folder.open = depth === 0;
          const summary = document.createElement('summary');
          const icon = document.createElement('span');
          icon.textContent = 'DIR';
          const name = document.createElement('strong');
          name.textContent = node.name;
          const count = document.createElement('small');
          count.textContent = String(node.children.size);
          summary.append(icon, name, count);
          const contents = document.createElement('div');
          contents.className = 'zip-preview-children';
          renderArchiveNodes(contents, node, depth + 1);
          folder.append(summary, contents);
          parentElement.append(folder);
        } else {
          const file = document.createElement('div');
          file.className = 'zip-preview-file';
          const icon = document.createElement('span');
          icon.textContent = 'FILE';
          const name = document.createElement('strong');
          name.textContent = node.name;
          const size = document.createElement('small');
          size.textContent = formatPreviewBytes(node.uncompressedSize);
          file.append(icon, name, size);
          parentElement.append(file);
        }
      }
    };

    const renderArchivePreview = (payload) => {
      const sevenZip = payload.kind === '7z';
      if (payload.encrypted) {
        showPreviewMessage(
          sevenZip
            ? message('encryptedSevenZip', 'This 7z archive is password-protected.')
            : message('encryptedArchive', 'This ZIP archive is password-protected.'),
          sevenZip
            ? message('encryptedSevenZipDetail', 'Archive contents are not shown for encrypted 7z files.')
            : message('encryptedArchiveDetail', 'Archive contents are not shown for encrypted ZIP files.'),
          'warning'
        );
        return null;
      }
      if (!payload.entries?.length) {
        if (payload.truncated && payload.totalEntries > 0) {
          showPreviewMessage(message('archiveTruncated', 'Only the first {{count}} archive entries are shown.', { count: 0 }));
          return null;
        }
        showPreviewMessage(
          sevenZip
            ? message('emptySevenZip', 'This 7z archive is empty.')
            : message('emptyArchive', 'This ZIP archive is empty.')
        );
        return null;
      }

      const shell = document.createElement('div');
      shell.className = 'zip-preview-shell';
      const summary = document.createElement('div');
      summary.className = 'zip-preview-summary';
      const title = document.createElement('strong');
      title.textContent = message('archiveContents', 'Archive contents');
      const metadata = document.createElement('span');
      const totalEntries = Number(payload.totalEntries) || 0;
      const countSuffix = payload.totalEntriesExact === false ? '+' : '';
      const sizeSuffix = payload.totalsExact === false ? '+' : '';
      const metadataParts = [
        `${totalEntries}${countSuffix} ${totalEntries === 1 ? message('item', 'item') : message('items', 'items')}`,
        `${formatPreviewBytes(payload.totalUncompressedSize)}${sizeSuffix}`
      ];
      if (payload.metadataOnly) {
        metadataParts.push(message('metadataOnlyArchive', 'Metadata only (no extraction)'));
      }
      metadata.textContent = metadataParts.join(' · ');
      summary.append(title, metadata);
      shell.append(summary);

      const tree = document.createElement('div');
      tree.className = 'zip-preview-tree';
      renderArchiveNodes(tree, buildArchiveTree(payload.entries));
      shell.append(tree);

      if (payload.truncated) {
        const notice = document.createElement('p');
        notice.className = 'zip-preview-notice';
        notice.textContent = message('archiveTruncated', 'Only the first {{count}} archive entries are shown.', { count: payload.entries.length });
        shell.append(notice);
      }
      return shell;
    };

    const renderPdfPreview = (item) => {
      const shell = document.createElement('div');
      shell.className = 'pdf-preview-shell';
      const frame = document.createElement('iframe');
      frame.className = 'pdf-preview-frame';
      frame.src = item.dataset.previewUrl;
      frame.title = message('pdfPreviewTitle', 'PDF preview for {{name}}', { name: item.dataset.fileName });
      const fallback = document.createElement('a');
      fallback.className = 'pdf-preview-fallback';
      fallback.href = item.dataset.previewUrl;
      fallback.target = '_blank';
      fallback.rel = 'noopener';
      fallback.textContent = message('openPdfNewTab', 'Open PDF in a new tab');
      shell.append(frame, fallback);
      return shell;
    };

    const loadFilePreview = async (item, sheetIndex = 0) => {
      if (!item || item !== selectedItem) return;
      const { previewKind, previewUrl, fileId } = item.dataset;
      const previewKey = `${fileId}:${previewKind}:${sheetIndex}`;
      if (loadedPreviewKey === previewKey && previewContent && !previewContent.hidden) return;
      if (!previewKind) {
        showPreviewMessage(message('previewUnavailable', 'Preview is not available for this file type.'));
        return;
      }
      if (!previewUrl) {
        showPreviewMessage(
          message('previewRequiresDownload', 'Preview requires download permission.'),
          message('previewRequiresDownloadDetail', 'Ask the repository owner for download access.'),
          'warning'
        );
        return;
      }

      if (previewKind === 'pdf') {
        loadedPreviewKey = previewKey;
        showPreviewContent(renderPdfPreview(item));
        return;
      }

      showPreviewMessage(message('loadingPreview', 'Loading preview…'), '', 'loading');
      previewController = new AbortController();
      try {
        const separator = previewUrl.includes('?') ? '&' : '?';
        const url = previewKind === 'xlsx' ? `${previewUrl}${separator}sheet=${sheetIndex}` : previewUrl;
        const payload = await fetchPreviewJson(url, previewController.signal);
        if (item !== selectedItem) return;
        if (previewKind === 'xlsx') {
          loadedPreviewKey = `${fileId}:${previewKind}:${payload.sheet?.index ?? sheetIndex}`;
          showPreviewContent(renderSpreadsheetPreview(item, payload));
        } else if (previewKind === 'zip' || previewKind === '7z') {
          const content = renderArchivePreview(payload);
          loadedPreviewKey = previewKey;
          if (content) showPreviewContent(content);
        }
      } catch (error) {
        if (error.name === 'AbortError') return;
        loadedPreviewKey = '';
        showPreviewMessage(error.message || message('previewFailed', 'The file preview could not be loaded.'), '', 'error');
      } finally {
        previewController = null;
      }
    };

    detailTabs.forEach((button) => {
      button.addEventListener('click', () => {
        const tabName = button.dataset.detailsTab;
        setDetailsTab(tabName);
        if (tabName === 'preview' && selectedItem) loadFilePreview(selectedItem);
      });
    });

    const clearSelection = () => {
      selectedItem = null;
      resetPreview();
      setDetailsTab('details');
      fileItems.forEach((item) => {
        item.classList.remove('is-selected');
        const checkbox = item.querySelector('[data-file-select]');
        if (checkbox) checkbox.checked = false;
      });
      if (selectionLabel) selectionLabel.textContent = message('noItemSelected', 'No item selected');
      if (selectedDownload) {
        selectedDownload.href = '#';
        selectedDownload.classList.add('is-disabled');
        selectedDownload.setAttribute('aria-disabled', 'true');
        selectedDownload.tabIndex = -1;
      }
      if (selectedDeleteForm) selectedDeleteForm.action = '#';
      if (selectedDeleteButton) {
        selectedDeleteButton.disabled = true;
        selectedDeleteButton.classList.add('is-disabled');
      }
      if (detailsPane) detailsPane.classList.add('is-empty');
      if (detailsEmpty) detailsEmpty.hidden = false;
      if (detailsContent) detailsContent.hidden = true;
    };

    const selectFile = (item) => {
      if (!item || item.hidden) return;
      if (selectedItem === item) return;
      clearSelection();
      selectedItem = item;
      item.classList.add('is-selected');
      const checkbox = item.querySelector('[data-file-select]');
      if (checkbox) checkbox.checked = true;

      const data = item.dataset;
      if (selectionLabel) selectionLabel.textContent = message('oneSelected', '1 selected · {{name}}', { name: data.fileName });
      if (selectedDownload) {
        selectedDownload.href = data.downloadUrl;
        selectedDownload.classList.remove('is-disabled');
        selectedDownload.setAttribute('aria-disabled', 'false');
        selectedDownload.tabIndex = 0;
      }
      if (selectedDeleteForm) {
        selectedDeleteForm.action = data.deleteUrl;
        selectedDeleteForm.dataset.confirm = message('deleteFileConfirm', "Permanently delete '{{name}}'?", { name: data.fileName });
      }
      if (selectedDeleteButton) {
        selectedDeleteButton.disabled = false;
        selectedDeleteButton.classList.remove('is-disabled');
      }

      if (detailsPane) detailsPane.classList.remove('is-empty');
      if (detailsEmpty) detailsEmpty.hidden = true;
      if (detailsContent) detailsContent.hidden = false;
      setDetailsValue('[data-detail-name]', data.fileName);
      setDetailsValue('[data-detail-mime]', data.fileMime);
      setDetailsValue('[data-detail-type]', data.fileType);
      setDetailsValue('[data-detail-size]', data.fileSize);
      setDetailsValue('[data-detail-date]', data.fileDate);
      setDetailsValue('[data-detail-owner]', data.fileOwner);

      const detailIcon = explorer.querySelector('[data-detail-icon]');
      if (detailIcon) {
        Array.from(detailIcon.classList)
          .filter((className) => className.startsWith('file-'))
          .forEach((className) => detailIcon.classList.remove(className));
        detailIcon.classList.add(`file-${data.fileKind || 'file'}`);
        detailIcon.textContent = kindCodes[data.fileKind] || 'FILE';
      }
      if (detailDownload && data.downloadUrl) detailDownload.href = data.downloadUrl;
      if (detailDeleteForm) {
        detailDeleteForm.action = data.deleteUrl;
        detailDeleteForm.dataset.confirm = message('deleteFileConfirm', "Permanently delete '{{name}}'?", { name: data.fileName });
      }
    };

    const isInteractiveTarget = (target) => Boolean(target.closest('a, button, input, label, summary, form, details, select'));
    fileItems.forEach((item) => {
      const primaryLink = item.querySelector('[data-file-primary]');
      primaryLink?.addEventListener('click', (event) => {
        event.preventDefault();
        selectFile(item);
      });
      primaryLink?.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (item.dataset.downloadUrl) startDownload(item.dataset.downloadUrl, item.dataset.fileName);
      });
      item.addEventListener('click', (event) => {
        if (!isInteractiveTarget(event.target)) selectFile(item);
      });
      item.addEventListener('dblclick', (event) => {
        if (!isInteractiveTarget(event.target)) if (item.dataset.downloadUrl) startDownload(item.dataset.downloadUrl, item.dataset.fileName);
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectFile(item);
        }
      });
      item.querySelector('[data-file-select]')?.addEventListener('change', (event) => {
        if (event.currentTarget.checked) selectFile(item);
        else if (selectedItem === item) clearSelection();
      });
    });
    detailsClose?.addEventListener('click', clearSelection);

    const updateFilter = (button) => {
      const filter = button.dataset.fileFilter || 'all';
      const acceptedKinds = filter === 'all' ? null : filter.split(',');
      let count = 0;
      folderItems.forEach((item) => {
        const visible = !acceptedKinds;
        item.hidden = !visible;
        if (visible) count += 1;
      });
      fileItems.forEach((item) => {
        const visible = !acceptedKinds || acceptedKinds.includes(item.dataset.fileKind);
        item.hidden = !visible;
        if (visible) count += 1;
      });
      if (selectedItem?.hidden) clearSelection();
      filterButtons.forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle('is-active', active);
        candidate.setAttribute('aria-pressed', String(active));
      });
      const label = button.querySelector('span')?.textContent?.trim() || message('allFiles', 'All files');
      if (categoryHeading) categoryHeading.textContent = label;
      if (visibleCount) visibleCount.textContent = String(count);
      if (visibleItemLabel) visibleItemLabel.textContent = count === 1 ? message('item', 'item') : message('items', 'items');
      if (statusCount) statusCount.textContent = String(count);
      if (statusItemLabel) statusItemLabel.textContent = count === 1 ? message('item', 'item') : message('items', 'items');
      if (filterEmpty) filterEmpty.hidden = count > 0;
      if (fileItemsContainer) fileItemsContainer.hidden = count === 0;
      if (listHeader) listHeader.hidden = count === 0 || fileItemsContainer?.dataset.view === 'grid';
    };
    filterButtons.forEach((button) => button.addEventListener('click', () => updateFilter(button)));


    explorer.addEventListener('click', (event) => {
      const downloadLink = event.target.closest('[data-download-link]');
      if (!downloadLink || event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = downloadLink.getAttribute('href');
      if (!url || url === '#' || downloadLink.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      const item = downloadLink.closest('[data-file-item]');
      const filename = item?.dataset.fileName || selectedItem?.dataset.fileName || 'download';
      startDownload(url, filename);
    });

    document.addEventListener('click', (event) => {
      document.querySelectorAll('.explorer-file-menu[open]').forEach((menu) => {
        if (!menu.contains(event.target)) menu.removeAttribute('open');
      });
    });

    document.addEventListener('keydown', (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'f' && explorerSearch) {
        event.preventDefault();
        explorerSearch.focus();
        explorerSearch.select();
      }
      if (event.key === 'Escape') {
        if (folderDrawer && !folderDrawer.hidden) closeFolderDrawer();
        else if (uploadDrawer && !uploadDrawer.hidden) closeUploadDrawer();
        else if (selectedItem) clearSelection();
      }
    });
  }



  const tlsSettingsForm = document.querySelector('[data-tls-settings-form]');
  if (tlsSettingsForm) {
    const httpsEnabled = tlsSettingsForm.querySelector('[data-https-enabled]');
    const redirectEnabled = tlsSettingsForm.querySelector('[data-https-redirect]');
    const publicHostname = tlsSettingsForm.querySelector('[data-public-hostname]');
    const certificateModeInputs = Array.from(tlsSettingsForm.querySelectorAll('[data-certificate-mode]'));
    const autoReload = tlsSettingsForm.querySelector('[data-auto-reload]');

    const updateTlsFields = () => {
      const httpsActive = Boolean(httpsEnabled?.checked);
      const redirectActive = httpsActive && Boolean(redirectEnabled?.checked);
      const reloadActive = httpsActive && Boolean(autoReload?.checked);
      const certificateMode = certificateModeInputs.find((input) => input.checked)?.value || 'pem';

      tlsSettingsForm.querySelectorAll('[data-https-dependent]').forEach((element) => {
        element.classList.toggle('is-disabled-section', !httpsActive);
      });
      tlsSettingsForm.querySelectorAll('[data-redirect-dependent]').forEach((element) => {
        element.classList.toggle('is-disabled-section', !redirectActive);
      });
      tlsSettingsForm.querySelectorAll('[data-reload-dependent]').forEach((element) => {
        element.classList.toggle('is-disabled-section', !reloadActive);
      });

      if (publicHostname) publicHostname.required = redirectActive;
      const pemFields = tlsSettingsForm.querySelector('[data-pem-fields]');
      const pfxFields = tlsSettingsForm.querySelector('[data-pfx-fields]');
      if (pemFields) pemFields.hidden = certificateMode !== 'pem';
      if (pfxFields) pfxFields.hidden = certificateMode !== 'pfx';
    };

    httpsEnabled?.addEventListener('change', updateTlsFields);
    redirectEnabled?.addEventListener('change', updateTlsFields);
    autoReload?.addEventListener('change', updateTlsFields);
    certificateModeInputs.forEach((input) => input.addEventListener('change', updateTlsFields));
    updateTlsFields();
  }


  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

  const base64urlToUint8Array = (value) => {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + padding;
    const binary = window.atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };

  const arrayBufferToBase64url = (value) => {
    const bytes = new Uint8Array(value || new ArrayBuffer(0));
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };

  const creationOptionsFromJSON = (options) => ({
    ...options,
    challenge: base64urlToUint8Array(options.challenge),
    user: {
      ...options.user,
      id: base64urlToUint8Array(options.user.id)
    },
    excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: base64urlToUint8Array(credential.id)
    }))
  });

  const requestOptionsFromJSON = (options) => ({
    ...options,
    challenge: base64urlToUint8Array(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: base64urlToUint8Array(credential.id)
    }))
  });

  const registrationCredentialToJSON = (credential) => ({
    id: credential.id,
    rawId: arrayBufferToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
      attestationObject: arrayBufferToBase64url(credential.response.attestationObject),
      transports: typeof credential.response.getTransports === 'function'
        ? credential.response.getTransports()
        : []
    }
  });

  const authenticationCredentialToJSON = (credential) => ({
    id: credential.id,
    rawId: arrayBufferToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
      authenticatorData: arrayBufferToBase64url(credential.response.authenticatorData),
      signature: arrayBufferToBase64url(credential.response.signature),
      userHandle: credential.response.userHandle
        ? arrayBufferToBase64url(credential.response.userHandle)
        : undefined
    }
  });

  const fetchJSON = async (url, body = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed with status ${response.status}.`);
    return payload;
  };

  const passkeyRegisterButton = document.querySelector('[data-passkey-register]');
  if (passkeyRegisterButton) {
    const nameInput = document.querySelector('[data-passkey-name]');
    const status = document.querySelector('[data-passkey-register-status]');
    passkeyRegisterButton.addEventListener('click', async () => {
      if (!window.PublicKeyCredential || !navigator.credentials) {
        if (status) status.textContent = status.dataset.notSupported || 'This browser does not support WebAuthn passkeys.';
        return;
      }
      passkeyRegisterButton.disabled = true;
      if (status) status.textContent = status.dataset.working || 'Waiting for your authenticator…';
      try {
        const options = await fetchJSON(passkeyRegisterButton.dataset.optionsUrl, {
          name: nameInput?.value || ''
        });
        const credential = await navigator.credentials.create({
          publicKey: creationOptionsFromJSON(options)
        });
        if (!credential) throw new Error('The authenticator did not return a credential.');
        const result = await fetchJSON(passkeyRegisterButton.dataset.verifyUrl, {
          credential: registrationCredentialToJSON(credential)
        });
        window.location.assign(result.redirect || '/settings#security');
      } catch (error) {
        if (status) status.textContent = error.message;
        passkeyRegisterButton.disabled = false;
      }
    });
  }

  const passkeyAuthenticateButton = document.querySelector('[data-passkey-authenticate]');
  if (passkeyAuthenticateButton) {
    const status = document.querySelector('[data-passkey-auth-status]');
    passkeyAuthenticateButton.addEventListener('click', async () => {
      if (!window.PublicKeyCredential || !navigator.credentials) {
        if (status) status.textContent = status.dataset.notSupported || 'This browser does not support WebAuthn passkeys.';
        return;
      }
      passkeyAuthenticateButton.disabled = true;
      if (status) status.textContent = status.dataset.working || 'Waiting for your passkey…';
      try {
        const options = await fetchJSON(passkeyAuthenticateButton.dataset.optionsUrl);
        const credential = await navigator.credentials.get({
          publicKey: requestOptionsFromJSON(options)
        });
        if (!credential) throw new Error('The authenticator did not return a credential.');
        const result = await fetchJSON(passkeyAuthenticateButton.dataset.verifyUrl, {
          credential: authenticationCredentialToJSON(credential)
        });
        window.location.assign(result.redirect || '/');
      } catch (error) {
        if (status) status.textContent = error.message;
        passkeyAuthenticateButton.disabled = false;
      }
    });
  }

  const copyRecoveryButton = document.querySelector('[data-copy-recovery-codes]');
  if (copyRecoveryButton) {
    const status = document.querySelector('[data-copy-recovery-status]');
    copyRecoveryButton.addEventListener('click', async () => {
      const codes = Array.from(document.querySelectorAll('[data-recovery-code-list] .recovery-code'))
        .map((element) => element.textContent.trim())
        .filter(Boolean);
      try {
        await navigator.clipboard.writeText(codes.join('\n'));
        if (status) status.textContent = status.dataset.copied || 'Recovery keys copied.';
      } catch {
        if (status) status.textContent = codes.join('  ');
      }
    });
  }

})();
