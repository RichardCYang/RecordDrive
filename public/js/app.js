(() => {
  const passwordToggles = document.querySelectorAll('[data-password-toggle]');
  passwordToggles.forEach((button) => {
    button.addEventListener('click', () => {
      const wrapper = button.closest('.input-with-icon');
      const input = wrapper?.querySelector('[data-password-input]');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? 'Hide' : 'Show';
      button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      const message = form.dataset.confirm || 'Do you want to continue?';
      if (!window.confirm(message)) event.preventDefault();
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
      summary.textContent = `${files.length} ${files.length === 1 ? 'file' : 'files'} · ${formatBytes(total)}`;
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
    uploadForm.addEventListener('submit', () => {
      const button = uploadForm.querySelector('button[type="submit"]');
      if (button) {
        button.disabled = true;
        button.textContent = 'Uploading…';
      }
    });
  }

  const explorer = document.querySelector('[data-file-explorer]');
  if (explorer) {
    const uploadDrawer = explorer.querySelector('[data-upload-drawer]');
    const uploadOpenButtons = explorer.querySelectorAll('[data-upload-open]');
    const uploadCloseButton = explorer.querySelector('[data-upload-close]');
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

    const openUploadDrawer = () => {
      if (!uploadDrawer) return;
      uploadDrawer.hidden = false;
      uploadDrawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      window.setTimeout(() => uploadDrawer.querySelector('[data-drop-zone]')?.focus?.(), 180);
    };

    const closeUploadDrawer = () => {
      if (uploadDrawer) uploadDrawer.hidden = true;
    };

    uploadOpenButtons.forEach((button) => button.addEventListener('click', openUploadDrawer));
    uploadCloseButton?.addEventListener('click', closeUploadDrawer);
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

    const clearSelection = () => {
      selectedItem = null;
      fileItems.forEach((item) => {
        item.classList.remove('is-selected');
        const checkbox = item.querySelector('[data-file-select]');
        if (checkbox) checkbox.checked = false;
      });
      if (selectionLabel) selectionLabel.textContent = 'No item selected';
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
      if (selectionLabel) selectionLabel.textContent = `1 selected · ${data.fileName}`;
      if (selectedDownload) {
        selectedDownload.href = data.downloadUrl;
        selectedDownload.classList.remove('is-disabled');
        selectedDownload.setAttribute('aria-disabled', 'false');
        selectedDownload.tabIndex = 0;
      }
      if (selectedDeleteForm) {
        selectedDeleteForm.action = data.deleteUrl;
        selectedDeleteForm.dataset.confirm = `Permanently delete '${data.fileName}'?`;
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
      if (detailDownload) detailDownload.href = data.downloadUrl;
      if (detailDeleteForm) {
        detailDeleteForm.action = data.deleteUrl;
        detailDeleteForm.dataset.confirm = `Permanently delete '${data.fileName}'?`;
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
        window.location.assign(item.dataset.downloadUrl);
      });
      item.addEventListener('click', (event) => {
        if (!isInteractiveTarget(event.target)) selectFile(item);
      });
      item.addEventListener('dblclick', (event) => {
        if (!isInteractiveTarget(event.target)) window.location.assign(item.dataset.downloadUrl);
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
      const label = button.querySelector('span')?.textContent?.trim() || 'All files';
      if (categoryHeading) categoryHeading.textContent = label;
      if (visibleCount) visibleCount.textContent = String(count);
      if (visibleItemLabel) visibleItemLabel.textContent = count === 1 ? 'item' : 'items';
      if (statusCount) statusCount.textContent = String(count);
      if (statusItemLabel) statusItemLabel.textContent = count === 1 ? 'item' : 'items';
      if (filterEmpty) filterEmpty.hidden = count > 0;
      if (fileItemsContainer) fileItemsContainer.hidden = count === 0;
      if (listHeader) listHeader.hidden = count === 0 || fileItemsContainer?.dataset.view === 'grid';
    };
    filterButtons.forEach((button) => button.addEventListener('click', () => updateFilter(button)));

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
        if (uploadDrawer && !uploadDrawer.hidden) closeUploadDrawer();
        else if (selectedItem) clearSelection();
      }
    });
  }

})();
