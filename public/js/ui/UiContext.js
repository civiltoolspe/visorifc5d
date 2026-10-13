// Contexto compartido por los componentes de la UI: acceso al ctx de la aplicación,
// helpers de rol/bloqueo y consultas tolerantes a los demás módulos.

import { safe } from './dom.js';

export class UiContext {
  constructor(ctx, root, layers) {
    this.ctx = ctx;
    this.store = ctx.store;
    this.bus = ctx.bus;
    this.actions = ctx.actions;
    this.root = root; // elemento .ui
    this.layers = layers; // { popover, modal, toast }
    this.popovers = new Set();
    this.modals = new Set();
    this.dialogs = null; // lo asigna App.js
    this.about = null; // diálogo "Acerca de" (AboutDialog); lo asigna App.js. Su estado abierto/cerrado es local, no del store
  }

  // ---------- Rol y bloqueo ----------
  get presentation() {
    return this.store.get('presentation');
  }

  isViewer() {
    return this.presentation.role === 'viewer';
  }

  isPresenter() {
    return this.presentation.role === 'presenter';
  }

  // Misma regla que Presentation: espectador con presentación activa (o sin navegación libre) o
  // presentador que no es el activo mientras otro presenta.
  isLocked() {
    const p = this.presentation;
    const following = !!p.active && !p.isActivePresenter;
    return (p.role === 'viewer' && (!!p.active || p.viewerFreeNav === false)) || (p.role !== 'viewer' && following);
  }

  isBroadcasting() {
    const p = this.presentation;
    return !!p.active && !!p.isActivePresenter;
  }

  // ---------- Capas flotantes ----------
  closePopovers(except = null) {
    for (const p of [...this.popovers]) if (p !== except) p.close();
  }

  // Cierra lo que esté abierto por encima (modal o popover). Devuelve true si cerró algo.
  closeTopOverlay() {
    const modals = [...this.modals];
    if (modals.length) {
      const top = modals[modals.length - 1];
      if (top.dismissable) top.close(false);
      return true;
    }
    for (const p of this.popovers) {
      if (p.isOpen) {
        p.close();
        return true;
      }
    }
    return false;
  }

  hasOverlay() {
    if (this.modals.size || this.about?.isOpen) return true;
    for (const p of this.popovers) if (p.isOpen) return true;
    return false;
  }

  // ---------- Avisos ----------
  toast(type, message, timeout) {
    this.bus.emit('toast', { type, message, timeout });
  }

  // ---------- Consultas tolerantes a otros módulos ----------
  get ifc() {
    return this.ctx.ifc;
  }

  get cad() {
    return this.ctx.cad;
  }

  get viewer() {
    return this.ctx.viewer;
  }

  records() {
    return this.store.get('modelRecords') || [];
  }

  ifcLoaded(modelId) {
    return !!safe(() => this.ifc?.has?.(modelId), false);
  }

  cadLoaded(modelId) {
    return !!safe(() => this.cad?.has?.(modelId), false);
  }

  // Niveles del conjunto. Los IFC federados (p. ej. arquitectura + estructura) tienen niveles homónimos
  // a la misma cota de mapa: se agrupan en un solo nivel (±10 cm), que es como los trata IfcManager
  // en el modo "solo". Cada entrada lleva `members` con todos los niveles agrupados.
  storeys() {
    const raw = safe(() => this.ifc?.getStoreys?.(), []) || [];
    const out = [];
    for (const s of raw) {
      const prev = out[out.length - 1];
      // Solo se agrupan niveles de modelos distintos (dos niveles del mismo modelo nunca se fusionan)
      if (prev && Number.isFinite(s.mapHeight) && Math.abs(s.mapHeight - prev.mapHeight) <= 0.1 && !prev.members.some((m) => m.modelId === s.modelId)) {
        prev.members.push({ modelId: s.modelId, expressId: s.expressId });
        if (s.elementCount != null) prev.elementCount = (prev.elementCount || 0) + s.elementCount;
        continue;
      }
      out.push({ ...s, members: [{ modelId: s.modelId, expressId: s.expressId }] });
    }
    return out;
  }

  // ¿Es `active` ({ modelId, expressId }) este nivel (o alguno de los niveles agrupados en él)?
  storeyMatches(storey, active) {
    if (!storey || !active) return false;
    const list = storey.members || [{ modelId: storey.modelId, expressId: storey.expressId }];
    return list.some((m) => m.modelId === active.modelId && m.expressId === active.expressId);
  }

  typeSummary() {
    return safe(() => this.ifc?.getTypeSummary?.(), []) || [];
  }

  // Tipos IFC que están realmente ocultos: visibility.hiddenTypes más IfcSpace mientras display.showSpaces sea false
  // (los espacios están ocultos por defecto). `types` = resultado de typeSummary() (solo cuenta IfcSpace si existe).
  effectiveHiddenTypes(types = this.typeSummary()) {
    const set = new Set((this.store.get('visibility')?.hiddenTypes || []).map((t) => String(t).toUpperCase()));
    if (!this.store.get('display')?.showSpaces && types.some((t) => t.type === 'IFCSPACE')) set.add('IFCSPACE');
    return set;
  }

  selectionItems() {
    return this.store.get('selection')?.items || [];
  }

  elementInfo(item) {
    return safe(() => this.ifc?.getElementInfo?.(item.modelId, item.expressId), null);
  }

  // Recuento de lo que de verdad se dibuja, para los contadores del dock y de la pestaña Inicio:
  //   { total, hidden, visible, visibleCategories }
  // Un elemento cuenta como oculto si lo está por su tipo (visibility.hiddenTypes + IfcSpace sin "Mostrar espacios"), a mano
  // (visibility.hidden) o porque su modelo está oculto con el ojo de la tarjeta (models[id].visible === false). Las categorías
  // que solo existen en modelos ocultos tampoco cuentan como visibles. `types` = typeSummary() (se puede pasar ya calculado).
  visibilitySummary(types = this.typeSummary()) {
    const vis = this.store.get('visibility') || {};
    const modelsState = this.store.get('models') || {};
    const hiddenTypes = this.effectiveHiddenTypes(types);
    const countHidden = (list) => list.reduce((a, t) => a + (hiddenTypes.has(t.type) ? t.count : 0), 0);
    const summaries = [];
    for (const m of safe(() => this.ifc?.getModels?.(), []) || []) {
      const s = safe(() => this.ifc?.getModelSummary?.(m.id), null);
      if (s) summaries.push({ id: m.id, s });
    }

    let total = 0;
    let hidden = 0;
    const presentTypes = new Set(); // categorías que tienen algún elemento en un modelo visible
    if (summaries.length) {
      for (const { id, s } of summaries) {
        const n = s.elementCount || 0;
        total += n;
        if (modelsState[id]?.visible === false) {
          hidden += n;
          continue;
        }
        const own = Array.isArray(s.types) ? s.types : types; // sin desglose por modelo se usa el global
        for (const t of own) presentTypes.add(t.type);
        hidden += Math.min(n, countHidden(own) + (vis.hidden?.[id]?.length || 0));
      }
    } else {
      total = types.reduce((a, t) => a + (t.count || 0), 0);
      hidden = Math.min(total, countHidden(types) + this.hiddenCount());
      for (const t of types) presentTypes.add(t.type);
    }
    hidden = Math.min(total, hidden);
    return {
      total,
      hidden,
      visible: Math.max(0, total - hidden),
      visibleCategories: types.filter((t) => !hiddenTypes.has(t.type) && presentTypes.has(t.type)).length,
    };
  }

  // Cuenta de elementos ocultos manualmente (no incluye tipos ocultos)
  hiddenCount() {
    const hidden = this.store.get('visibility')?.hidden || {};
    let n = 0;
    for (const ids of Object.values(hidden)) n += ids.length;
    return n;
  }

  fitSelectionOrAll() {
    const items = this.selectionItems();
    const viewer = this.viewer;
    if (!viewer) return;
    if (items.length) {
      const box = safe(() => this.ifc?.getBoxOf?.(items), null);
      if (box && !box.isEmpty?.()) {
        viewer.fitToBox(box);
        return;
      }
    }
    viewer.fitAll?.();
  }
}
