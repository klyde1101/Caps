export function mountUpdatesAndLegal(api, root = document) {
  const $ = selector => root.querySelector(selector);
  const toggle = $('#automatic-updates'), check = $('#check-app-update'), status = $('#app-update-status');
  const progress = $('#app-update-progress'), documentChoice = $('#legal-document'), content = $('#legal-document-content');
  function render(state) {
    toggle.checked = state.automatic !== false;
    $('#app-update-version').textContent = `Caps ${state.version}`;
    status.textContent = state.message;
    check.disabled = ['checking', 'downloading', 'ready'].includes(state.state);
    progress.hidden = state.state !== 'downloading';
    progress.value = state.percent || 0;
  }
  check.addEventListener('click', async () => {
    check.disabled = true;
    try { render(await api.checkAppUpdate()); }
    catch (error) { status.textContent = error.message; check.disabled = false; }
  });
  toggle.addEventListener('change', async () => {
    const automatic = toggle.checked; toggle.disabled = true;
    try { render(await api.setAutoUpdate(automatic)); }
    catch (error) { toggle.checked = !automatic; status.textContent = error.message; }
    finally { toggle.disabled = false; }
  });
  api.onAppUpdate?.(render);
  void api.getAppUpdate?.().then(render).catch(error => { status.textContent = error.message; });
  let request = 0;
  async function loadDocument() {
    const current = ++request;
    content.setAttribute('aria-busy', 'true');
    $('#legal-document-status').textContent = 'Loading document…';
    try {
      const text = await api.getLegalDocument(documentChoice.value);
      if (current !== request) return;
      if (documentChoice.value === 'notices') {
        const notice = root.createElement('p'); notice.textContent = text;
        content.replaceChildren(notice); $('#legal-document-status').textContent = '';
        return;
      }
      const sections = text.trim().split(/\r?\n\s*\r?\n/);
      const nodes = [];
      for (const [index, section] of sections.entries()) {
        const lines = section.split(/\r?\n/);
        if (index === 0) {
          const heading = root.createElement('h4'); heading.textContent = lines.shift(); nodes.push(heading);
          if (lines.length) { const meta = root.createElement('p'); meta.textContent = lines.join('\n'); nodes.push(meta); }
        } else if (lines.length > 1 && lines[0].length < 85 && !lines[0].endsWith(',') && !lines[0].endsWith('.')) {
          const heading = root.createElement('h5'); heading.textContent = lines.shift(); nodes.push(heading);
          const paragraph = root.createElement('p'); paragraph.textContent = lines.join('\n'); nodes.push(paragraph);
        } else { const paragraph = root.createElement('p'); paragraph.textContent = section; nodes.push(paragraph); }
      }
      content.replaceChildren(...nodes);
      $('#legal-document-status').textContent = '';
    } catch (error) {
      if (current === request) { content.replaceChildren(); $('#legal-document-status').textContent = `Could not open this document. ${error.message}`; }
    } finally { if (current === request) content.setAttribute('aria-busy', 'false'); }
  }
  documentChoice.addEventListener('change', loadDocument);
  if (api.getLegalDocument) void loadDocument();
}
