/* Accessible dropdown presentation; the original select remains the data/form API. */
(function () {
  'use strict';
  if (window.EcoTrackSelectControls) return;
  const controls = new WeakMap();
  let open = null, sequence = 0;

  function close(returnFocus = false) {
    if (!open) return;
    const previous = open; open = null;
    previous.menu.remove(); previous.button.setAttribute('aria-expanded', 'false');
    previous.button.removeAttribute('aria-activedescendant');
    if (returnFocus && previous.button.isConnected) previous.button.focus();
  }
  function position() {
    if (!open) return;
    const { button, menu } = open, rect = button.getBoundingClientRect();
    if (!button.isConnected || !rect.width || !rect.height) return close();
    const width = Math.min(Math.max(rect.width, open.select.dataset.selectSize === 'compact' ? 144 : 220), window.innerWidth - 24);
    const below = window.innerHeight - rect.bottom - 18, above = rect.top - 18;
    const height = Math.min(280, Math.max(below, above));
    menu.style.width = width + 'px'; menu.style.maxHeight = Math.max(80, height) + 'px';
    menu.style.left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px';
    const actual = menu.getBoundingClientRect().height;
    menu.style.top = (below >= actual || below >= above ? rect.bottom + 6 : Math.max(12, rect.top - actual - 6)) + 'px';
  }
  function mark(index) {
    if (!open) return;
    open.active = index;
    for (const item of open.items) item.element.classList.toggle('eco-option-active', item.index === index);
    const active = open.items.find(item => item.index === index);
    if (!active) return;
    open.button.setAttribute('aria-activedescendant', active.element.id);
    const { menu } = open, row = active.element;
    if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
  }
  function choose(index) {
    if (!open || open.select.options[index]?.disabled) return;
    const { select, button } = open;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index; close(); controls.get(select).sync(); button.focus();
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function show(select, button) {
    close(); controls.get(select).sync();
    if (select.disabled) return;
    const menu = document.createElement('div');
    menu.id = button.getAttribute('aria-controls'); menu.className = 'eco-select-menu';
    if (select.dataset.selectSize === 'compact') menu.classList.add('eco-select-menu-compact');
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', button.getAttribute('aria-label'));
    const items = [];
    let group = null;
    Array.from(select.options).forEach((option, index) => {
      if (option.hidden || option.style.display === 'none') return;
      const parent = option.parentElement;
      if (parent.tagName === 'OPTGROUP' && group !== parent) {
        group = parent; const heading = document.createElement('div');
        heading.className = 'eco-select-group'; heading.textContent = parent.label; menu.append(heading);
      }
      const row = document.createElement('div');
      row.id = menu.id + '-' + index; row.className = 'eco-select-option'; row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(select.selectedIndex === index));
      const disabled = option.disabled || (parent.tagName === 'OPTGROUP' && parent.disabled);
      row.setAttribute('aria-disabled', String(disabled)); row.textContent = option.textContent;
      if (!disabled) {
        row.addEventListener('pointermove', () => mark(index));
        row.addEventListener('pointerdown', event => event.preventDefault());
        row.addEventListener('click', () => choose(index)); items.push({ index, value: option.value, element: row });
      }
      menu.append(row);
    });
    (button.closest('dialog[open]') || document.body).append(menu);
    open = { select, button, menu, items, active: select.selectedIndex, search: '', searchAt: 0 };
    button.setAttribute('aria-expanded', 'true'); position();
    mark(items.some(item => item.index === select.selectedIndex) ? select.selectedIndex : items[0]?.index);
  }
  function enhance(select) {
    if (controls.has(select) || select.multiple || select.size > 1 || select.hidden ||
      select.classList.contains('sr-only') || select.classList.contains('hidden') ||
      select.getAttribute('aria-hidden') === 'true' || select.style.display === 'none') return;
    const button = document.createElement('button'), label = document.createElement('span');
    button.type = 'button'; button.className = select.className + ' eco-select-trigger';
    button.dataset.selectId = select.id; button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'eco-select-options-' + (++sequence));
    label.className = 'eco-select-value'; button.append(label);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ class: 'eco-select-arrow', width: '16', height: '16',
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) arrow.setAttribute(name, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6 9l6 6 6-6'); arrow.append(path); button.append(arrow);
    const name = select.getAttribute('aria-label') || Array.from(select.labels || []).map(item => item.textContent.trim()).join(' ') ||
      select.title || select.options[0]?.textContent || 'Choose an option';
    button.setAttribute('aria-label', name);
    select.classList.add('eco-native-select'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    select.insertAdjacentElement('afterend', button);
    function sync() {
      if (!select.classList.contains('eco-native-select')) select.classList.add('eco-native-select');
      button.className = select.className.replace(/\beco-native-select\b/g, '').trim() + ' eco-select-trigger';
      button.hidden = select.hidden || select.classList.contains('hidden') || select.style.display === 'none';
      label.textContent = select.selectedOptions[0]?.textContent || 'Choose';
      button.disabled = select.disabled;
      button.setAttribute('aria-required', String(select.required));
      button.setAttribute('aria-invalid', String(select.matches(':user-invalid')));
      const describedBy = select.getAttribute('aria-describedby');
      if (describedBy) button.setAttribute('aria-describedby', describedBy);
      if (open?.select === select) {
        const highlighted = open.items.find(item => item.index === open.active)?.value;
        show(select, button);
        const item = open?.items.find(item => item.value === highlighted);
        if (item) mark(item.index);
      }
    }
    controls.set(select, { button, sync }); sync();
    select.addEventListener('change', sync); select.addEventListener('input', sync);
    select.addEventListener('focus', () => button.focus());
    select.addEventListener('invalid', event => { event.preventDefault(); button.setAttribute('aria-invalid', 'true'); button.focus(); });
    select.form?.addEventListener('reset', () => setTimeout(sync));
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['disabled', 'selected', 'required', 'aria-describedby', 'class', 'hidden', 'style'] });
    button.addEventListener('click', () => open?.button === button ? close() : show(select, button));
    button.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key === 'Tab') { close(); return; }
      const navigation = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (navigation.includes(event.key)) {
        event.preventDefault(); if (!open || open.button !== button) show(select, button);
        const items = open?.items || []; if (!items.length) return;
        let index = items.findIndex(item => item.index === open.active);
        index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
          Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
        mark(items[index].index);
      } else if ((event.key === 'Enter' || event.key === ' ') && open?.button === button) {
        event.preventDefault(); choose(open.active);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
        event.preventDefault(); if (!open || open.button !== button) show(select, button);
        if (!open) return;
        const now = Date.now(); open.search = now - open.searchAt > 700 ? event.key : open.search + event.key;
        open.searchAt = now;
        const matched = open.items.find(item => select.options[item.index].textContent.trim().toLowerCase().startsWith(open.search.toLowerCase()));
        if (matched) mark(matched.index);
      }
    });
  }
  function scan(root) {
    if (root.nodeType !== 1 && root !== document) return;
    if (root.matches?.('select')) enhance(root);
    root.querySelectorAll('select').forEach(enhance);
  }
  function init() {
    scan(document);
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) scan(node);
      if (open && !open.button.isConnected) close();
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerdown', event => {
      if (open && !open.menu.contains(event.target) && !open.button.contains(event.target)) close();
    }, true);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', event => { if (open && event.target !== open.menu) position(); }, true);
    window.addEventListener('pagehide', () => close());
  }
  window.EcoTrackSelectControls = { refresh: () => scan(document), close };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
