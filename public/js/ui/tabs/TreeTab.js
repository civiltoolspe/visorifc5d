// Pestaña Árbol: árbol espacial de cada IFC (ifc.getSpatialTree), perezoso (los hijos se
// dibujan al expandir; más de 300 hijos -> "mostrar más"). Clic selecciona, doble clic encuadra,
// el ojo oculta/muestra. Se resalta la selección y se hace scroll hasta ella (también en espectadores).

import { h, clear, safe, setClass, debounce, setAttr } from '../dom.js';
import { icon } from '../icons.js';
import { TabBase } from './TabBase.js';
import { emptyState, iconButton } from '../widgets.js';
import { formatInt } from '../format.js';

const PAGE = 300;
const MAX_FILTER_MATCHES = 400;
const INDENT = 14;

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

const TYPE_ICON = {
  IFCPROJECT: 'cube',
  IFCSITE: 'pin',
  IFCBUILDING: 'building',
  IFCBUILDINGSTOREY: 'layers',
  IFCSPACE: 'grid',
};

const keyOf = (modelId, expressId) => `${modelId}:${expressId}`;

// Elementos (no espaciales) que cuelgan de un nodo, sin recursión profunda.
function collectElementIds(node) {
  const out = [];
  const stack = [...(node.children || [])];
  while (stack.length) {
    const n = stack.pop();
    if (!n.isSpatial) out.push(n.expressId);
    if (n.children?.length) stack.push(...n.children);
  }
  return out;
}

export class TreeTab extends TabBase {
  constructor(ui) {
    super(ui, 'tree', 'Árbol');
    this.expandState = new Map(); // key -> boolean (decisión del usuario)
    this.shown = new Map(); // key del padre -> nº de hijos dibujados
    this.rows = new Map(); // key -> { modelId, node, depth, rowEl, wrapEl, kidsEl, eyeEl, caretEl }
    this.indexCache = new Map(); // modelId -> { tree, nodes, parents }
    this.descCache = new WeakMap(); // node -> number[]
    this.hayCache = new WeakMap(); // node -> string normalizado
    this.filter = '';
    this.hiddenSets = new Map();
    this.selKeys = new Set();
    this._lightDirty = false;
    this._pendingReveal = false;

    this.filterInput = h('input', { type: 'text', class: 'input input--search', placeholder: 'Filtrar el árbol…', 'aria-label': 'Filtrar el árbol espacial', autocomplete: 'off', spellcheck: 'false' });
    this.collapseBtn = iconButton({ icon: 'chevron-up', title: 'Contraer todo', className: 'btn--sm btn--ghost', size: 17, onClick: () => this._collapseAll() });
    this.revealBtn = iconButton({ icon: 'crosshair', title: 'Ir al elemento seleccionado', className: 'btn--sm btn--ghost', size: 17, onClick: () => this._revealSelection(true) });
    const applyFilter = debounce(() => {
      this.filter = this.filterInput.value.trim();
      this.render();
    }, 200);
    this.filterInput.addEventListener('input', applyFilter);
    this.filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.filterInput.value) {
        e.stopPropagation();
        this.filterInput.value = '';
        this.filter = '';
        this.render();
      }
    });
    this.addCleanup(() => applyFilter.cancel());

    this.treeEl = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Árbol espacial' });
    this.treeEl.addEventListener('keydown', (e) => this._onKey(e));
    this.el.append(h('div', { class: 'tree-tools' }, h('div', { class: 'input-icon' }, icon('filter', { size: 15 }), this.filterInput), this.revealBtn, this.collapseBtn), this.treeEl);

    // Cambios que solo afectan a clases (selección, visibilidad, modelos): actualización ligera
    this._light = debounce(() => this._refreshStates(), 0);
    this.watch(['selection', 'visibility', 'models'], () => this._onLightChange());
    this.watch(['modelRecords'], () => this.schedule());
    this.onBus(['model:loaded', 'model:unloaded'], () => {
      this.indexCache.clear();
      this.schedule();
    });
  }

  onShow() {
    if (this._lightDirty) this._refreshStates();
    if (this._pendingReveal) this._revealSelection(false);
  }

  // ------------------------------------------------------------------ índice y utilidades
  _models() {
    return this.ui.records().filter((r) => r.kind === 'ifc' && this.ui.ifcLoaded(r.id));
  }

  _tree(modelId) {
    return safe(() => this.ctx.ifc?.getSpatialTree?.(modelId), null);
  }

  _index(modelId) {
    const tree = this._tree(modelId);
    let idx = this.indexCache.get(modelId);
    if (idx && idx.tree === tree) return idx;
    idx = { tree, nodes: new Map(), parents: new Map() };
    if (tree) {
      const stack = [tree];
      idx.nodes.set(tree.expressId, tree);
      while (stack.length) {
        const n = stack.pop();
        for (const c of n.children || []) {
          idx.nodes.set(c.expressId, c);
          idx.parents.set(c.expressId, n);
          stack.push(c);
        }
      }
    }
    this.indexCache.set(modelId, idx);
    return idx;
  }

  _descendants(modelId, node) {
    let ids = this.descCache.get(node);
    if (!ids) {
      ids = safe(() => this.ctx.ifc?.getDescendants?.(modelId, node.expressId), null);
      if (!Array.isArray(ids) && !(ids instanceof Int32Array) && !(ids instanceof Uint32Array)) ids = collectElementIds(node);
      this.descCache.set(node, ids);
    }
    return ids;
  }

  _nodeName(node) {
    return (node.name || '').trim() || node.typeLabel || node.type || `#${node.expressId}`;
  }

  _defaultExpanded(node, depth) {
    return !!node.isSpatial && depth < 3 && node.type !== 'IFCBUILDINGSTOREY';
  }

  _isExpanded(key, node, depth) {
    return this.expandState.has(key) ? this.expandState.get(key) : this._defaultExpanded(node, depth);
  }

  // ------------------------------------------------------------------ dibujo completo
  draw() {
    const models = this._models();
    const root = clear(this.treeEl);
    this.rows.clear();
    this._snapshotStates();

    if (!models.length) {
      root.append(emptyState({ icon: 'tree', title: 'Sin modelo IFC', text: 'Carga un archivo IFC para explorar su estructura espacial.' }));
      this.collapseBtn.disabled = true;
      this.revealBtn.disabled = true;
      return;
    }
    this.collapseBtn.disabled = false;
    this.revealBtn.disabled = false;

    const q = norm(this.filter);
    let total = 0;
    for (const rec of models) {
      const tree = this._tree(rec.id);
      const block = h('section', { class: 'tmodel', 'aria-label': rec.name });
      const modelState = this.store.get('models')[rec.id];
      const visible = modelState?.visible !== false;
      const eye = iconButton({
        icon: visible ? 'eye' : 'eye-off',
        title: visible ? 'Ocultar el modelo' : 'Mostrar el modelo',
        className: `btn--sm btn--ghost${visible ? '' : ' is-off'}`,
        size: 16,
        onClick: () => this.actions.setModelVisible(rec.id, !visible),
      });
      block.append(h('header', { class: 'tmodel__head' }, h('span', { class: 'model__kind model__kind--ifc', text: 'IFC' }), h('span', { class: 'tmodel__name', title: rec.name, text: rec.name }), eye));
      const nodesEl = h('div', { class: 'tmodel__nodes', role: 'group' });
      block.append(nodesEl);
      root.append(block);

      if (!tree || (!tree.children?.length && tree.expressId < 0)) {
        nodesEl.append(h('p', { class: 'muted pad', text: 'Este modelo no tiene estructura espacial.' }));
        continue;
      }
      if (q) {
        const set = new Set();
        const stats = { matches: 0, capped: false };
        this._collectMatches(tree, q, set, stats);
        total += stats.matches;
        if (!set.has(tree)) nodesEl.append(h('p', { class: 'muted pad', text: 'Sin coincidencias en este modelo.' }));
        else nodesEl.append(this._renderNode(rec.id, tree, 0, { filterSet: set, query: q }));
        if (stats.capped) nodesEl.append(h('p', { class: 'muted pad', text: `Se muestran las primeras ${MAX_FILTER_MATCHES} coincidencias. Afina el filtro.` }));
      } else {
        nodesEl.append(this._renderNode(rec.id, tree, 0, null));
      }
    }
    if (q && total === 0) root.append(h('p', { class: 'muted pad', text: `Ningún nodo coincide con “${this.filter}”.` }));

    this._refreshStates();
    this._revealSelection(false);
    // Un único elemento enfocable (roving tabindex)
    const first = this.treeEl.querySelector('.trow');
    if (first) first.tabIndex = 0;
  }

  _collectMatches(node, q, set, stats) {
    let hay = this.hayCache.get(node);
    if (hay === undefined) {
      hay = norm(`${node.name || ''} ${node.typeLabel || ''} ${node.type || ''}`);
      this.hayCache.set(node, hay);
    }
    let any = false;
    const own = hay.includes(q);
    if (own && stats.matches < MAX_FILTER_MATCHES) {
      stats.matches++;
      any = true;
    } else if (own) stats.capped = true;
    for (const c of node.children || []) {
      if (stats.matches >= MAX_FILTER_MATCHES) {
        stats.capped = true;
        break;
      }
      if (this._collectMatches(c, q, set, stats)) any = true;
    }
    if (any) set.add(node);
    return any;
  }

  // ------------------------------------------------------------------ nodos
  // opts: null (modo perezoso) | { filterSet, query } (modo filtro: todo expandido)
  _renderNode(modelId, node, depth, opts) {
    const key = keyOf(modelId, node.expressId);
    const hasKids = !!node.children?.length;
    const filtering = !!opts;
    const expanded = filtering ? hasKids : hasKids && this._isExpanded(key, node, depth);

    const caret = hasKids
      ? h('button', { type: 'button', class: 'trow__caret', tabindex: '-1', title: expanded ? 'Contraer' : 'Expandir', 'aria-label': expanded ? 'Contraer' : 'Expandir' }, icon('chevron-right', { size: 14 }))
      : h('span', { class: 'trow__caret trow__caret--empty', 'aria-hidden': 'true' });
    const iconName = TYPE_ICON[node.type] || null;
    const glyph = iconName ? h('span', { class: 'trow__icon' }, icon(iconName, { size: 15 })) : h('span', { class: 'trow__icon trow__icon--dot' }, h('i'));
    const label = this._nodeName(node);
    const nameEl = h('span', { class: 'trow__name', title: label, text: label });
    const subtitle = node.isSpatial ? (hasKids ? formatInt(node.children.length) : '') : node.typeLabel || '';
    const eye = h('button', { type: 'button', class: 'trow__eye', tabindex: '-1' });
    const rowEl = h(
      'div',
      { class: `trow${node.isSpatial ? ' is-spatial' : ''}`, role: 'treeitem', tabindex: '-1', 'aria-level': String(depth + 1), 'aria-selected': 'false', 'data-key': key, style: { paddingLeft: `${depth * INDENT + 4}px` } },
      caret,
      glyph,
      h('span', { class: 'trow__text' }, nameEl, subtitle ? h('span', { class: 'trow__type', text: subtitle }) : null),
      eye,
    );
    if (hasKids) rowEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    const wrapEl = h('div', { class: 'tnode', 'data-node': key }, rowEl);
    const kidsEl = hasKids ? h('div', { class: 'tchildren', role: 'group', hidden: !expanded }) : null;
    if (kidsEl) wrapEl.append(kidsEl);
    const rec = { modelId, node, depth, rowEl, wrapEl, kidsEl, eyeEl: eye, caretEl: caret, opts };
    this.rows.set(key, rec);

    if (hasKids && expanded) this._renderChildren(rec);

    // Eventos
    rowEl.addEventListener('click', (e) => {
      if (e.target.closest('.trow__eye')) return;
      if (e.target.closest('.trow__caret') && hasKids) {
        this._toggle(rec);
        return;
      }
      this._activate(rec, e);
    });
    rowEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('.trow__eye') || e.target.closest('.trow__caret')) return;
      this._fit(rec);
    });
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleHidden(rec);
    });
    return wrapEl;
  }

  _renderChildren(rec) {
    const { node, modelId, depth, kidsEl, opts } = rec;
    if (!kidsEl) return;
    // Olvida las filas de los hijos anteriores
    for (const el of kidsEl.querySelectorAll('[data-node]')) this.rows.delete(el.dataset.node);
    clear(kidsEl);
    let kids = node.children || [];
    if (opts) kids = kids.filter((c) => opts.filterSet.has(c));
    const key = keyOf(modelId, node.expressId);
    const limit = opts ? kids.length : this.shown.get(key) ?? PAGE;
    const slice = kids.slice(0, limit);
    for (const c of slice) kidsEl.append(this._renderNode(modelId, c, depth + 1, opts));
    if (kids.length > limit) {
      const rest = kids.length - limit;
      const more = h(
        'button',
        { type: 'button', class: 'tmore', style: { marginLeft: `${(depth + 1) * INDENT + 22}px` } },
        icon('plus', { size: 14 }),
        h('span', { text: `Mostrar ${Math.min(PAGE, rest)} más (quedan ${formatInt(rest)})` }),
      );
      more.addEventListener('click', () => {
        this.shown.set(key, limit + PAGE);
        this._renderChildren(rec);
        this._refreshStates();
      });
      kidsEl.append(more);
    }
  }

  _toggle(rec, force) {
    if (!rec.kidsEl) return;
    const key = keyOf(rec.modelId, rec.node.expressId);
    const open = typeof force === 'boolean' ? force : rec.kidsEl.hidden;
    if (!rec.opts) this.expandState.set(key, open);
    if (open && !rec.kidsEl.childElementCount) this._renderChildren(rec);
    rec.kidsEl.hidden = !open;
    rec.rowEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    rec.caretEl.title = open ? 'Contraer' : 'Expandir';
    setClass(rec.rowEl, 'is-open', open);
    if (open) this._refreshStates();
  }

  _activate(rec, e) {
    const { node, modelId } = rec;
    rec.rowEl.focus({ preventScroll: true });
    if (node.isSpatial) {
      if (node.children?.length) this._toggle(rec);
      return;
    }
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    this.actions.select([{ modelId, expressId: node.expressId }], { toggle: additive });
  }

  _fit(rec) {
    const { node, modelId } = rec;
    const items = node.isSpatial ? this._descendants(modelId, node).map((expressId) => ({ modelId, expressId })) : [{ modelId, expressId: node.expressId }];
    if (!items.length) return;
    const box = safe(() => this.ctx.ifc?.getBoxOf?.(items), null);
    if (box && !box.isEmpty?.()) safe(() => this.ctx.viewer?.fitToBox?.(box));
  }

  // ---- ocultar / mostrar
  _idsOf(rec) {
    return rec.node.isSpatial ? Array.from(this._descendants(rec.modelId, rec.node)) : [rec.node.expressId];
  }

  _toggleHidden(rec) {
    const ids = this._idsOf(rec);
    if (!ids.length) return;
    const hiddenSet = this.hiddenSets.get(rec.modelId) || new Set();
    const allHidden = ids.every((id) => hiddenSet.has(id));
    if (allHidden) {
      const vis = this.store.get('visibility');
      const drop = new Set(ids);
      const hidden = { ...vis.hidden, [rec.modelId]: (vis.hidden[rec.modelId] || []).filter((id) => !drop.has(id)) };
      this.store.patch('visibility', { hidden });
    } else {
      this.actions.hideElements(ids.map((expressId) => ({ modelId: rec.modelId, expressId })));
    }
  }

  // ------------------------------------------------------------------ estados (selección y visibilidad)
  _onLightChange() {
    if (!this.active) {
      this._lightDirty = true;
      this._pendingReveal = true;
      return;
    }
    this._light();
    this._pendingReveal = true;
    clearTimeout(this._revealTimer);
    this._revealTimer = setTimeout(() => this._revealSelection(false), 0);
  }

  _snapshotStates() {
    this.hiddenSets.clear();
    const vis = this.store.get('visibility');
    for (const [modelId, ids] of Object.entries(vis.hidden || {})) this.hiddenSets.set(modelId, new Set(ids));
    this.selKeys = new Set(this.ui.selectionItems().map((it) => keyOf(it.modelId, it.expressId)));
  }

  _refreshStates() {
    this._lightDirty = false;
    this._snapshotStates();
    const modelsState = this.store.get('models') || {};
    for (const [key, rec] of this.rows) {
      const { node, modelId, rowEl, eyeEl } = rec;
      const selected = !node.isSpatial && this.selKeys.has(key);
      let hidden;
      if (node.isSpatial) {
        const ids = this._descendants(modelId, node);
        const set = this.hiddenSets.get(modelId);
        hidden = !!set && ids.length > 0 && ids.every((id) => set.has(id));
      } else {
        hidden = !!this.hiddenSets.get(modelId)?.has(node.expressId);
      }
      if (modelsState[modelId]?.visible === false) rowEl.classList.add('is-model-off');
      else rowEl.classList.remove('is-model-off');
      setClass(rowEl, 'is-selected', selected);
      setClass(rowEl, 'is-hidden', hidden);
      setAttr(rowEl, 'aria-selected', selected ? 'true' : 'false');
      const want = hidden ? 'eye-off' : 'eye';
      if (eyeEl.dataset.icon !== want) {
        eyeEl.dataset.icon = want;
        eyeEl.replaceChildren(icon(want, { size: 15 }));
        const t = hidden ? 'Mostrar' : 'Ocultar';
        eyeEl.title = t;
        eyeEl.setAttribute('aria-label', `${t}: ${this._nodeName(node)}`);
      }
    }
    // Sincroniza el encabezado del modelo (ojo) cuando cambia 'models'
    this._syncModelHeads(modelsState);
  }

  _syncModelHeads(modelsState) {
    const heads = this.treeEl.querySelectorAll('.tmodel');
    const models = this._models();
    heads.forEach((block, i) => {
      const rec = models[i];
      if (!rec) return;
      const visible = modelsState[rec.id]?.visible !== false;
      const btn = block.querySelector('.tmodel__head .btn');
      if (btn && btn.classList.contains('is-off') === visible) {
        btn.classList.toggle('is-off', !visible);
        btn.replaceChildren(icon(visible ? 'eye' : 'eye-off', { size: 16 }));
        btn.title = visible ? 'Ocultar el modelo' : 'Mostrar el modelo';
        btn.setAttribute('aria-label', btn.title);
      }
    });
  }

  // ------------------------------------------------------------------ revelar la selección
  _revealSelection(force) {
    this._pendingReveal = false;
    if (!this.active) return;
    const items = this.ui.selectionItems();
    if (!items.length) return;
    // Revela el primer seleccionado que exista en el árbol
    for (const it of items.slice(0, 20)) {
      if (this._revealNode(it.modelId, it.expressId, force)) return;
    }
  }

  _revealNode(modelId, expressId, force) {
    if (this.filter) return false;
    const key = keyOf(modelId, expressId);
    let rec = this.rows.get(key);
    if (!rec) {
      const idx = this._index(modelId);
      const node = idx.nodes.get(expressId);
      if (!node) return false;
      const chain = [];
      let cur = idx.parents.get(expressId);
      while (cur) {
        chain.unshift(cur);
        cur = idx.parents.get(cur.expressId);
      }
      let parentRec = null;
      for (let i = 0; i < chain.length; i++) {
        const anc = chain[i];
        const aKey = keyOf(modelId, anc.expressId);
        parentRec = this.rows.get(aKey);
        if (!parentRec) return false;
        // Asegura que el siguiente en la cadena esté dentro de la página dibujada
        const next = i + 1 < chain.length ? chain[i + 1] : node;
        const pos = (anc.children || []).indexOf(next);
        const limit = this.shown.get(aKey) ?? PAGE;
        if (pos >= limit) {
          this.shown.set(aKey, Math.ceil((pos + 1) / PAGE) * PAGE);
          if (parentRec.kidsEl && !parentRec.kidsEl.hidden) this._renderChildren(parentRec);
        }
        if (parentRec.kidsEl?.hidden || !parentRec.kidsEl?.childElementCount) this._toggle(parentRec, true);
      }
      this._refreshStates();
      rec = this.rows.get(key);
    }
    if (!rec) return false;
    rec.rowEl.scrollIntoView({ block: force ? 'center' : 'nearest', behavior: 'auto' });
    return true;
  }

  // ------------------------------------------------------------------ acciones globales
  _collapseAll() {
    this.expandState.clear();
    this.shown.clear();
    this.filterInput.value = '';
    this.filter = '';
    this.render();
  }

  // ------------------------------------------------------------------ teclado
  _visibleRows() {
    return [...this.treeEl.querySelectorAll('.trow')].filter((r) => r.offsetParent !== null);
  }

  _onKey(e) {
    const row = e.target.closest?.('.trow');
    if (!row) return;
    const rec = this.rows.get(row.dataset.key);
    if (!rec) return;
    const rows = this._visibleRows();
    const i = rows.indexOf(row);
    const focusRow = (el) => {
      if (!el) return;
      for (const r of rows) r.tabIndex = -1;
      el.tabIndex = 0;
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(rows[i + 1]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(rows[i - 1]);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (rec.kidsEl?.hidden) this._toggle(rec, true);
        else focusRow(rows[i + 1]);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (rec.kidsEl && !rec.kidsEl.hidden) this._toggle(rec, false);
        else {
          const parentRow = rec.wrapEl.parentElement?.closest('.tnode')?.querySelector(':scope > .trow');
          focusRow(parentRow);
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this._activate(rec, e);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(rows[0]);
        break;
      case 'End':
        e.preventDefault();
        focusRow(rows[rows.length - 1]);
        break;
      default:
    }
  }
}
