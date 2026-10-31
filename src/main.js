'use strict';

const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, MarkdownRenderChild, TFile, Scope, Platform, setIcon, normalizePath, stringifyYaml, parseYaml } = require('obsidian');
const { eventFromFrontmatter, parseHistoricalDate, normalizeTags, normalizeAliases } = require('./model');
const { renderTimeline } = require('./renderer');
const { matchingSuggestions, searchText } = require('./suggestions');
const { createChartPreferences } = require('./chart-preferences');
const { createReadingPreferences } = require('./reading-preferences');

const VIEW_TYPE = 'historical-timeline-view';
const DEFAULTS = { eventFolder: 'History/Events', defaultTimeline: '', scanFolder: '' };
const READING_MESSAGE = 'Reading mode is on. Switch to Editing in the timeline toolbar to make changes.';
const FIELDS = ['aliases', 'timeline', 'timeline-title', 'timeline-date', 'timeline-end', 'timeline-category', 'timeline-summary', 'timeline-location', 'timeline-source', 'timeline-tags', 'timeline-important', 'timeline-undated', 'timeline-perspectives', 'timeline-kind'];

// Obsidian handles shortcuts before DOM bubbling. Own Escape only while this
// search field has focus, then release the scope on blur, rerender or unload.
function bindSearchEscape(app, input, exitSearch, parentScope = app.scope, focusRoot = input) {
  const scope = new Scope(parentScope);
  scope.register([], 'Escape', event => { if (exitSearch(event)) return false; });
  let active = false;
  const focus = () => { if (!active) { app.keymap.pushScope(scope); active = true; } };
  const region = focusRoot !== input;
  const blur = event => {
    if (region && event?.relatedTarget && focusRoot.contains(event.relatedTarget)) return;
    if (active) { app.keymap.popScope(scope); active = false; }
  };
  focusRoot.addEventListener(region ? 'focusin' : 'focus', focus);
  focusRoot.addEventListener(region ? 'focusout' : 'blur', blur);
  if (input.ownerDocument.activeElement === input) focus();
  return () => { blur(); focusRoot.removeEventListener(region ? 'focusin' : 'focus', focus); focusRoot.removeEventListener(region ? 'focusout' : 'blur', blur); };
}

function element(parent, tag, className, text) {
  const el = parent.ownerDocument.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  parent.appendChild(el);
  return el;
}

// Keep nested modal scroll containers stable during local additions/removals.
function preserveEditorScroll(element, callback) {
  const positions=[];
  for(let node=element;node;node=node.parentElement) positions.push([node,node.scrollTop,node.scrollLeft]);
  const result=callback();
  for(const [node,top,left] of positions){if(top!==undefined)node.scrollTop=top;if(left!==undefined)node.scrollLeft=left;}
  return result;
}

// Shared keyboard-first suggestions for text fields and event pickers.
function attachSuggestions(input, getChoices, choose, bounds = () => [0, input.value.length]) {
  const box = element(input.parentElement, 'div', 'ht-type-suggestions'); box.hidden = true;
  box.setAttribute('aria-label', 'Suggestions');
  let items = [], active = 0;
  const setActive = index => {
    active = index;
    items.forEach((item, i) => item.classList.toggle('ht-suggestion-active', i === index));
  };
  const hide = () => { box.hidden = true; items = []; };
  const chooseItem = (choice, start, end) => preserveEditorScroll(input,()=>{
    const target = choose(choice, start, end);
    // A compact picker can replace its search field with an attachment chip.
    (typeof target?.focus === 'function' ? target : input).focus({preventScroll:true}); hide();
  });
  const refresh = () => {
    const [start, end] = bounds();
    const query = input.value.slice(start, end).trim();
    box.replaceChildren(); active = 0;
    items = getChoices(query).slice(0, 10).map(choice => {
      const button = element(box, 'button', 'ht-type-suggestion', choice.label); button.type = 'button';
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('focus', () => setActive(items.indexOf(button)));
      button.addEventListener('mouseenter', () => {
        if (!items.includes(input.ownerDocument.activeElement)) setActive(items.indexOf(button));
      });
      button.addEventListener('click', () => chooseItem(choice, start, end));
      button.addEventListener('keydown', event => {
        if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation?.(); input.focus({preventScroll:true}); if (event.key === 'Escape') hide(); }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); const index = items.indexOf(button) + (event.key === 'ArrowUp' ? -1 : 1);
          if (index < 0 || index >= items.length) input.focus({preventScroll:true}); else items[index].focus();
        }
      });
      return button;
    });
    box.hidden = !items.length;
    setActive(0);
  };
  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { if (!box.hidden) { event.preventDefault(); event.stopPropagation?.(); } hide(); }
    else if (!box.hidden && items.length && event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation?.(); items[active].click(); }
    else if (!box.hidden && items.length && event.key === 'ArrowDown') { event.preventDefault(); items[0].focus(); }
  });
  input.parentElement.addEventListener('focusout', event => { if (!input.parentElement.contains?.(event.relatedTarget)) hide(); });
  return { refresh, hide };
}

function reusableSources(events, connections = []) {
  return [...new Set([...events.flatMap(event => [event.source, ...(event.perspectives || []).map(item => item.source)]), ...connections.map(link => link.source)].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function folderPath(value) {
  const text = String(value || '').trim().replace(/\\/g, '/');
  if (text.startsWith('/') || /^[a-z]:/i.test(text) || text.split('/').some(p => p.startsWith('.') || /[:*?"<>|\x00-\x1f]/.test(p))) {
    throw new Error('Use a vault-relative folder without hidden folders, .., or special filename characters.');
  }
  return text ? normalizePath(text) : '';
}

function filename(title) {
  return title.normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120).replace(/[.\s]+$/g, '') || 'Historical event';
}

function fieldsSnapshot(fm) {
  return JSON.stringify(FIELDS.map(key => [key, fm?.[key] ?? null]));
}

function previousEventInput(value) {
  if (!value || !Array.isArray(value.timelines) || !Array.isArray(value.tags) || typeof value.category !== 'string') return null;
  return {
    timelines: [...new Set(value.timelines.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))],
    category: value.category.trim(),
    tags: normalizeTags(value.tags.filter(item => typeof item === 'string'))
  };
}

function reusableEventInput(event, properties) {
  return previousEventInput({timelines:event.groups, category:properties['timeline-category'] || '', tags:event.tags});
}

function timelineGroups(value) {
  return [...new Set((Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

function timelineViewState(state = {}) {
  const excludedTags = normalizeTags(Array.isArray(state.excludedTags) ? state.excludedTags.filter(tag => typeof tag === 'string') : []);
  const groups = timelineGroups(Array.isArray(state.groups) ? state.groups : state.group);
  return { ...state, groups, excludedTags, group: groups.length === 1 ? groups[0] : '' };
}

// Only plugin-owned, undated records are eligible. Dated events and notes are
// independent timeline content. Keep archived records in the same atomic save.
function archiveUnusedEvents(data, candidates) {
  if(!Array.isArray(data.standaloneEvents)||!Array.isArray(data.connections||[])||!Array.isArray(data.analyses||[]))return 0;
  const used=new Set((data.connections||[]).flatMap(link=>[link.from,link.to]));
  for(const analysis of data.analyses||[]){
    used.add(analysis.headEventId);
    if(!Array.isArray(analysis.branches))return 0;
    for(const branch of analysis.branches){used.add(branch.eventId);if(!Array.isArray(branch.factors))return 0;for(const factor of branch.factors)used.add(factor.eventId);}
  }
  const unused=data.standaloneEvents.filter(record=>{
    if(!candidates.has(record.id)||candidates.get(record.id)!==JSON.stringify(record)||used.has('timeline:'+record.id))return false;
    const result=eventFromFrontmatter(record.properties,'',record.properties?.['timeline-title']);
    return !result.error&&result.event&&!result.event.start;
  });
  if(!unused.length)return 0;
  if(data.unusedEventArchive!==undefined&&!Array.isArray(data.unusedEventArchive))return 0;
  data.unusedEventArchive ||= [];
  for(const record of unused)data.unusedEventArchive.push({record,removedAt:new Date().toISOString()});
  const ids=new Set(unused.map(record=>record.id));
  data.standaloneEvents=data.standaloneEvents.filter(record=>!ids.has(record.id));
  return unused.length;
}

class HistoricalTimelinePlugin extends Plugin {
  async onload() {
    this.unloaded = false;
    this.writeQueue = Promise.resolve();
    this.index = new Map();
    this.listeners = new Set();
    this.refreshTimer = null;
    this.register(() => {
      this.unloaded = true;
      if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      this.listeners.clear();
      this.readingPreview?.close();
    });
    const saved = await this.loadData();
    if (this.unloaded) return;
    this.applySavedData(saved, false);
    this.registerView(VIEW_TYPE, leaf => new TimelineView(leaf, this));
    this.addRibbonIcon('history', 'Open historical timeline', () => this.openTimeline());
    this.addCommand({ id: 'open-timeline', name: 'Open timeline', callback: () => this.openTimeline() });
    this.addCommand({ id: 'add-event', name: 'Add historical event', checkCallback: checking => {
      if (this.isReadingMode()) return false;
      if (!checking) this.editEvent();
      return true;
    } });
    this.addCommand({ id: 'search-timeline-events', name: 'Search timeline events', checkCallback: checking => {
      const view = this.app.workspace.getActiveViewOfType(TimelineView);
      if (!view) return false;
      if (!checking) view.focusSearch();
      return true;
    } });
    this.addCommand({ id: 'edit-note-event', name: 'Add or edit timeline dates for current note', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (this.isReadingMode() || !file || file.extension !== 'md') return false;
      if (!checking) this.editEvent(file);
      return true;
    } });
    this.addSettingTab(new TimelineSettings(this.app, this));
    this.registerMarkdownCodeBlockProcessor('historical-timeline', (source, el, ctx) => {
      try {
        const config = source.trim() ? parseYaml(source) : {};
        if (config !== null && (typeof config !== 'object' || Array.isArray(config))) throw new Error('Use YAML options, such as timeline: World history');
        const options = config || {};
        for (const key of ['timeline', 'category', 'search', 'folder', 'title', 'mode', 'tag']) {
          if (options[key] !== undefined && typeof options[key] !== 'string') throw new Error(key + ' must be text.');
        }
        if (options.mode && !['cards', 'scale', 'vertical', 'wall', 'graph'].includes(options.mode)) throw new Error('mode must be cards, vertical, wall, or graph.');
        if (options.folder) options.folder = folderPath(options.folder);
        ctx.addChild(new TimelineEmbed(el, this, options));
      } catch (error) { element(el, 'p', 'ht-error', 'Timeline: ' + error.message); }
    });
    this.registerEvent(this.app.metadataCache.on('changed', file => { if (this.indexFile(file)) this.notify(); }));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.reindex()));
    this.registerEvent(this.app.vault.on('delete', file => { if (this.index.delete(file.path)) this.notify(); }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.unloaded) return;
      const remap = id => id === oldPath ? file.path : id.startsWith(oldPath + '/') ? file.path + id.slice(oldPath.length) : id;
      const analysisIds = (this.analyses || []).flatMap(item => [item.headEventId, ...(item.branches || []).flatMap(branch => [branch.eventId,...(branch.factors || []).map(factor => factor.eventId)])]).filter(Boolean);
      if (this.connections.some(link => remap(link.from) !== link.from || remap(link.to) !== link.to) || analysisIds.some(id => remap(id) !== id)) {
        this.mutateData(data => {
          for (const link of data.connections || []) { link.from = remap(link.from); link.to = remap(link.to); }
          for (const item of data.analyses || []) {
            if (item.headEventId) item.headEventId = remap(item.headEventId);
            for (const branch of item.branches || []) { if (branch.eventId) branch.eventId = remap(branch.eventId); for (const factor of branch.factors || []) if (factor.eventId) factor.eventId = remap(factor.eventId); }
          }
        }).catch(error => { if (!this.unloaded) new Notice(error.message); });
      }
      const removed = this.index.delete(oldPath);
      const changed = file instanceof TFile ? this.indexFile(file) : this.reindex(false);
      if (removed || changed) this.notify();
    }));
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.reindex();
      const snapshot=JSON.parse(JSON.stringify(saved||{}));
      const candidates=new Map((Array.isArray(snapshot.standaloneEvents)?snapshot.standaloneEvents:[]).map(record=>[record.id,JSON.stringify(record)]));
      if(!this.isReadingMode()&&archiveUnusedEvents(snapshot,candidates))this.mutateData(()=>{}).catch(error=>{if(!this.unloaded)new Notice('Unused event cleanup failed: '+error.message);});
    });
  }

  mobileStorage(doc) {
    if (!Platform?.isMobile) return undefined;
    doc ||= typeof document !== 'undefined' ? document : undefined;
    if (!this.deviceStorageResolved && doc?.defaultView) {
      this.deviceStorageResolved = true;
      try { this.deviceStorage = doc.defaultView.localStorage; } catch (_) { /* Use session memory when storage is blocked. */ }
    }
    return this.deviceStorage;
  }
  mobileChartPreferences(doc) {
    if (!Platform?.isMobile) return undefined;
    if (!this.chartPreferences) this.chartPreferences = createChartPreferences(this.mobileStorage(doc));
    return this.chartPreferences;
  }
  mobileReadingPreferences(doc) {
    if (!Platform?.isMobile) return undefined;
    if (!this.readingPreferences) this.readingPreferences = createReadingPreferences(this.mobileStorage(doc));
    return this.readingPreferences;
  }
  isReadingMode(doc) {
    if (!Platform?.isMobile) return false;
    doc ||= typeof document !== 'undefined' ? document : undefined;
    // A command may run before a view mounts; reading is the safe default.
    if (!this.readingPreferences && !doc?.defaultView) return true;
    return this.mobileReadingPreferences(doc).get();
  }
  setReadingMode(readOnly, doc) {
    if (!Platform?.isMobile || this.unloaded || typeof readOnly !== 'boolean') return;
    this.mobileReadingPreferences(doc).set(readOnly);
    this.readingPreview?.close();
    // Refresh every mounted timeline immediately without changing navigation history.
    for (const listener of this.listeners || []) listener();
  }
  mobileReadingOptions(doc) {
    if (!Platform?.isMobile) return {};
    return {
      readOnly: this.isReadingMode(doc),
      onReadOnlyChange: value => this.setReadingMode(value, doc),
      setIcon,
      onReadEvent: (event, renderPanel) => this.previewEvent(event, renderPanel),
      onOpenNote: event => this.openEvent(event)
    };
  }
  allowEditing() {
    if (!this.isReadingMode()) return true;
    new Notice(READING_MESSAGE);
    return false;
  }
  requireEditing() { if (this.isReadingMode()) throw new Error(READING_MESSAGE); }
  async mutateEventData(update) {
    this.requireEditing();
    return this.mutateData(data => { this.requireEditing(); return update(data); });
  }
  previewEvent(event, renderPanel) {
    if (this.unloaded || typeof renderPanel !== 'function') return;
    if (this.readingPreview) this.readingPreview.show(event, renderPanel);
    else {
      this.readingPreview = new ReadingPreviewModal(this.app, this, event, renderPanel);
      this.readingPreview.open();
    }
    const modal = this.readingPreview, presentation = {};
    modal.presentation = presentation;
    // A source view can be replaced by Sync while this native dialog is open.
    // Retire only the preview whose callbacks belonged to that renderer.
    return () => {
      if (this.readingPreview === modal && modal.presentation === presentation) modal.close();
    };
  }

  // Apply only the values this plugin displays; unrelated saved fields remain
  // on disk and are preserved by mutateData's fresh read before every write.
  applySavedData(saved, notify = true) {
    if (this.unloaded) return;
    const settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (typeof saved?.[key] === 'string') settings[key] = saved[key];
    for (const key of ['eventFolder', 'scanFolder']) {
      try { settings[key] = folderPath(settings[key]); }
      catch (_) { settings[key] = DEFAULTS[key]; }
    }
    const state = {
      standaloneEvents: Array.isArray(saved?.standaloneEvents) ? saved.standaloneEvents : [],
      ignoreCase: saved?.ignoreCase !== false,
      connections: Array.isArray(saved?.connections) ? saved.connections : [],
      analyses: Array.isArray(saved?.analyses) ? saved.analyses : [],
      viewOrder: Array.isArray(saved?.viewOrder) ? saved.viewOrder : [],
      previousEventInput: previousEventInput(saved?.previousEventInput),
      settings
    };
    const snapshot = JSON.stringify(state);
    const changed = snapshot !== this.dataSnapshot;
    const scanChanged = this.settings && this.settings.scanFolder !== settings.scanFolder;
    Object.assign(this, state);
    this.dataSnapshot = snapshot;
    if (scanChanged) this.reindex(false);
    if (changed && notify) this.notify();
  }

  // Obsidian calls this for external data.json changes, including Sync. Queue
  // the read with local writes, and never save from this callback.
  onExternalSettingsChange() {
    if (this.unloaded) return Promise.resolve();
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      if (this.unloaded) return;
      const saved = await this.loadData();
      if (this.unloaded || saved == null) return;
      if (typeof saved !== 'object' || Array.isArray(saved) ||
          ['standaloneEvents', 'connections', 'analyses', 'viewOrder'].some(key => saved[key] !== undefined && !Array.isArray(saved[key]))) {
        throw new Error('External timeline data is invalid. Existing events are still available; restore data.json from a backup before saving.');
      }
      this.applySavedData(saved);
    });
    this.writeQueue = operation;
    return operation.catch(error => { if (!this.unloaded) new Notice('Could not reload synced timeline data: ' + error.message); });
  }

  indexFile(file) {
    if (this.unloaded) return false;
    if (!(file instanceof TFile) || file.extension !== 'md') return false;
    const scope = this.settings.scanFolder;
    if (scope && !file.path.startsWith(scope + '/')) return this.index.delete(file.path);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const result = eventFromFrontmatter(fm, file.path, file.basename);
    if (!result.event && !result.error) return this.index.delete(file.path);
    if (JSON.stringify(this.index.get(file.path)) === JSON.stringify(result)) return false;
    this.index.set(file.path, result);
    return true;
  }

  reindex(notify = true) {
    if (this.unloaded) return false;
    const previous = this.index;
    this.index = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) this.indexFile(file);
    const changed = previous.size !== this.index.size || [...this.index].some(([path, result]) => JSON.stringify(previous.get(path)) !== JSON.stringify(result));
    if (changed && notify) this.notify();
    return changed;
  }
  notify() {
    if (this.unloaded) return;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.unloaded) return;
      for (const listener of this.listeners) listener();
    }, 120);
  }
  subscribe(callback) { if (this.unloaded) return () => {}; this.listeners.add(callback); return () => this.listeners.delete(callback); }
  getStandalone(id) { return this.standaloneEvents.find(event => event?.id === id); }
  async mutateData(update, notify = true) {
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      if (this.unloaded) throw new Error('The timeline plugin was unloaded. Reopen it before saving.');
      const loaded = await this.loadData();
      if (this.unloaded) throw new Error('The timeline plugin was unloaded. Reopen it before saving.');
      if (loaded != null && (typeof loaded !== 'object' || Array.isArray(loaded))) throw new Error('Saved timeline data is invalid. Restore data.json from a backup before saving.');
      const data = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? JSON.parse(JSON.stringify(loaded)) : {};
      if (['standaloneEvents', 'connections', 'analyses', 'viewOrder'].some(key => data[key] !== undefined && !Array.isArray(data[key]))) throw new Error('Saved timeline data is invalid. Restore data.json from a backup before saving.');
      data.standaloneEvents ||= [];
      const candidates=new Map(data.standaloneEvents.map(record=>[record.id,JSON.stringify(record)]));
      const result = update(data);
      if (!this.isReadingMode()) archiveUnusedEvents(data,candidates);
      await this.saveData(data);
      this.applySavedData(data, notify);
      return result;
    });
    this.writeQueue = operation;
    return operation;
  }
  async saveIgnoreCase(value) {
    await this.mutateData(data => { data.ignoreCase = Boolean(value); }, false);
  }
  showUndated(onSelect) { new UndatedModal(this.app, this, onSelect).open(); }
  async saveViewOrder(order) {
    const valid = ['cards', 'vertical', 'wall', 'graph'];
    if (!Array.isArray(order) || order.length !== valid.length || new Set(order).size !== valid.length || order.some(key => !valid.includes(key))) throw new Error('Invalid view order.');
    await this.mutateData(data => { data.viewOrder = [...order]; }, false);
  }
  editAnalysis(previous, group, onSaved, seed) { if (!this.allowEditing()) return; new AnalysisModal(this.app, this, previous, group, onSaved, seed).open(); }
  async saveAnalysis(draft, previous) {
    this.requireEditing();
    const text = value => typeof value === 'string' ? value.trim() : '';
    const title = text(draft.title);
    if (!title) throw new Error('Name the outcome or historical question at the head.');
    if (!Array.isArray(draft.branches)) throw new Error('Analysis branches are invalid.');
    if (!Array.isArray(draft.groups)) throw new Error('Analysis timelines are invalid.');
    const branches = draft.branches.map(branch => {
      if (!text(branch.title)) throw new Error('Give each branch a heading.');
      if (!Array.isArray(branch.factors)) throw new Error('Branch factors are invalid.');
      return { title: text(branch.title), eventId: text(branch.eventId), factors: branch.factors.map(factor => {
        if (!text(factor.title) && !text(factor.eventId)) throw new Error('Name each factor or select a supporting event.');
        return Object.fromEntries(['title','eventId','role','explanation','source','perspectives'].map(key => [key,text(factor[key])]).concat([['disputed',Boolean(factor.disputed)]]));
      }) };
    });
    return this.mutateEventData(data => {
      if (data.analyses !== undefined && !Array.isArray(data.analyses)) throw new Error('Saved analyses are invalid.');
      data.analyses ||= [];
      const existing = previous && data.analyses.find(item => item.id === previous.id);
      if (previous && (!existing || JSON.stringify(existing) !== JSON.stringify(previous))) throw new Error('This analysis changed. Reopen it before saving.');
      let id = existing?.id;
      if (!id) do { id = 'analysis-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); } while (data.analyses.some(item => item.id === id));
      const record = { id, title, causal:Boolean(draft.causal), headEventId:text(draft.headEventId), groups:[...new Set((draft.groups || []).map(text).filter(Boolean))], branches };
      if (existing) data.analyses[data.analyses.indexOf(existing)] = record; else data.analyses.push(record);
      return record;
    });
  }
  async deleteAnalysis(previous) {
    this.requireEditing();
    await this.mutateEventData(data => {
      const index = (data.analyses || []).findIndex(item => item.id === previous.id);
      if (index < 0 || JSON.stringify(data.analyses[index]) !== JSON.stringify(previous)) throw new Error('This analysis changed. Reopen it before removing.');
      data.analyses.splice(index,1);
    });
  }
  async saveConnection(draft, previous) {
    this.requireEditing();
    const events = this.collect().events;
    const pending = {};
    for (const key of ['from', 'to']) {
      if (!draft[key + 'New']) continue;
      const value = draft[key + 'New'];
      const title = String(value.title || '').trim();
      if (!title) throw new Error('Enter a name for the new event.');
      const properties = { 'timeline-title': title, timeline: Array.isArray(value.groups) ? value.groups : [] };
      if (value.kind === 'factor') { properties['timeline-kind']='factor'; properties['timeline-undated']=true; }
      else if (String(value.date || '').trim()) properties['timeline-date'] = parseHistoricalDate(value.date).canonical;
      else properties['timeline-undated'] = true;
      pending[key] = properties;
    }
    const relation = String(draft.relation || '').trim();
    if (!relation) throw new Error('Enter a relationship, such as contributed to.');
    return this.mutateEventData(data => {
      if (data.connections !== undefined && !Array.isArray(data.connections)) throw new Error('Saved connections are invalid.');
      data.connections ||= [];
      const endpoints = {};
      const liveIds = new Set([...events.filter(event => event.storage !== 'timeline').map(event => event.id), ...data.standaloneEvents.map(record => 'timeline:' + record.id)]);
      const titles = new Set([...events.flatMap(event => [event.title,...(event.aliases||[])].map(name=>name.toLocaleLowerCase())), ...data.standaloneEvents.map(record => String(record.properties?.['timeline-title'] || '').toLocaleLowerCase())]);
      for (const key of ['from', 'to']) {
        if (pending[key]) {
          const title = pending[key]['timeline-title'].toLocaleLowerCase();
          if (titles.has(title)) throw new Error('An event with this name already exists. Select it from the suggestions.');
          titles.add(title);
          let id; do { id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); } while (data.standaloneEvents.some(item => item.id === id));
          data.standaloneEvents.push({ id, folder: folderPath(this.settings.eventFolder), properties: pending[key] });
          endpoints[key] = 'timeline:' + id;
        } else {
          if (!liveIds.has(draft[key])) throw new Error('Both events must still be available.');
          endpoints[key] = draft[key];
        }
      }
      if (endpoints.from === endpoints.to) throw new Error('Choose two different events.');

      const existing = previous && data.connections.find(item => item.id === previous.id);
      if (previous && (!existing || JSON.stringify(existing) !== JSON.stringify(previous))) throw new Error('This connection changed. Reopen it before saving.');
      if (data.connections.some(item => item.id !== previous?.id && item.from === endpoints.from && item.to === endpoints.to && item.relation === relation)) throw new Error('This connection already exists.');
      let id = existing?.id;
      if (!id) do { id = 'link-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); } while (data.connections.some(item => item.id === id));
      const record = { id, from: endpoints.from, to: endpoints.to, relation, explanation: String(draft.explanation || '').trim(), source: String(draft.source || '').trim(), disputed: Boolean(draft.disputed) };
      if (existing) data.connections[data.connections.indexOf(existing)] = record; else data.connections.push(record);
      return record;
    });
  }
  async deleteConnection(previous) {
    this.requireEditing();
    return this.mutateEventData(data => {
      const index = (data.connections || []).findIndex(item => item.id === previous.id);
      if (index < 0 || JSON.stringify(data.connections[index]) !== JSON.stringify(previous)) throw new Error('This connection changed. Reopen it before deleting.');
      data.connections.splice(index, 1);
    });
  }
  editConnection(event, connection, direction) { if (!this.allowEditing()) return; new ConnectionModal(this.app, this, event, connection, direction).open(); }
  async saveSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) throw new Error('Unknown timeline setting.');
    await this.mutateData(data => { data[key] = value; });
  }
  async saveStandalone(properties, existingId, snapshot) {
    this.requireEditing();
    const result = eventFromFrontmatter(properties, '', properties['timeline-title']);
    if (result.error || !result.event) throw new Error(result.error || 'Enter a start date.');
    const newFolder = folderPath(this.settings.eventFolder);
    return this.mutateEventData(data => {
      const existing = existingId ? data.standaloneEvents.find(event => event?.id === existingId) : null;
      if (existingId && (!existing || JSON.stringify(existing) !== snapshot)) throw new Error('This event changed or was removed while the editor was open. Close and reopen it before saving.');
      let id = existingId;
      if (!id) do { id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); } while (data.standaloneEvents.some(event => event?.id === id));
      const fields = {};
      for (const key of FIELDS) if (properties[key] !== undefined && properties[key] !== '') fields[key] = properties[key];
      const record = { id, folder: existing ? existing.folder : newFolder, properties: JSON.parse(JSON.stringify(fields)) };
      if (existing) data.standaloneEvents[data.standaloneEvents.indexOf(existing)] = record; else data.standaloneEvents.push(record);
      if (!existing) data.previousEventInput = reusableEventInput(result.event, properties);
      return record;
    });
  }
  async deleteStandalone(id, snapshot) {
    this.requireEditing();
    return this.mutateEventData(data => {
      const record = data.standaloneEvents.find(event => event?.id === id);
      if (!record || JSON.stringify(record) !== snapshot) throw new Error('This event changed or was removed. Close and reopen the editor before deleting.');
      data.standaloneEvents.splice(data.standaloneEvents.indexOf(record), 1);
    });
  }
  collect(config = {}) {
    const events = [], errors = [];
    for (const [path, value] of this.index) {
      if (config.folder && !path.startsWith(config.folder + '/')) continue;
      if (value.error) { errors.push({ path, message: value.error }); continue; }
      const event = value.event;
      if (config.timeline && !event.groups.includes(config.timeline)) continue;
      if (config.category && event.category !== config.category) continue;
      if (config.tag && !event.tags.includes(config.tag.replace(/^#/, '').toLowerCase())) continue;
      events.push(event);
    }
    for (const record of this.standaloneEvents) {
      if (!record || typeof record.id !== 'string' || typeof record.folder !== 'string') {
        errors.push({ path: 'Timeline event', message: 'Invalid saved event record.' }); continue;
      }
      const inFolder = folder => !folder || record.folder === folder || record.folder.startsWith(folder + '/');
      if (!inFolder(this.settings.scanFolder) || !inFolder(config.folder)) continue;
      const result = eventFromFrontmatter(record.properties, '', 'Untitled event');
      if (result.error || !result.event) { errors.push({ path: 'Timeline event ' + record.id, message: result.error || 'Missing start date.' }); continue; }
      const event = { ...result.event, id: 'timeline:' + record.id, standaloneId: record.id, storage: 'timeline' };
      if (config.timeline && !event.groups.includes(config.timeline)) continue;
      if (config.category && event.category !== config.category) continue;
      if (config.tag && !event.tags.includes(config.tag.replace(/^#/, '').toLowerCase())) continue;
      events.push(event);
    }
    events.sort((a, b) => (a.start?.sortValue ?? Infinity) - (b.start?.sortValue ?? Infinity) || a.title.localeCompare(b.title));
    return { events, errors };
  }
  async openTimeline() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  openEvent(event) {
    if (event.storage === 'timeline') { this.editFromEvent(event); return; }
    const file = this.app.vault.getAbstractFileByPath(event.path);
    if (file instanceof TFile) {
      this.readingPreview?.close();
      const leaf = this.app.workspace.getLeaf('tab');
      const opened = this.isReadingMode() ? leaf.openFile(file, { state: { mode: 'preview' } }) : leaf.openFile(file);
      opened.catch(error => new Notice(error.message));
    }
    else new Notice('This note has moved or was deleted. The timeline will refresh.');
  }
  editEvent(file, group, onSaved) { if (!this.allowEditing()) return; new EventModal(this.app, this, file, group, undefined, onSaved).open(); }
  editFromEvent(event) {
    if (!this.allowEditing()) return;
    if (event.storage === 'timeline') {
      const record = this.getStandalone(event.standaloneId);
      if (record) new EventModal(this.app, this, undefined, undefined, record).open(); else new Notice('This event is no longer available.');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(event.path);
    if (file instanceof TFile) this.editEvent(file); else new Notice('This note is no longer available.');
  }
  async ensureFolder(path) {
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = current ? current + '/' + part : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error('A note already uses the folder path: ' + current);
      if (!existing) { this.requireEditing(); await this.app.vault.createFolder(current); }
    }
  }
  async saveEvent(data, file, snapshot) {
    this.requireEditing();
    const result = eventFromFrontmatter(data, file?.path || 'new.md', data['timeline-title']);
    if (result.error || !result.event) throw new Error(result.error || 'Enter a start date.');
    if (file) {
      if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error('The note was deleted. Close the editor and try again.');
      await this.app.fileManager.processFrontMatter(file, fm => {
        this.requireEditing();
        if (snapshot !== fieldsSnapshot(fm)) throw new Error('Timeline properties changed while this editor was open. Close and reopen it to keep the latest changes.');
        for (const key of FIELDS) {
          if (key === 'aliases' && data[key] === undefined) continue;
          if (data[key] === undefined || data[key] === '') delete fm[key]; else fm[key] = data[key];
        }
      });
      return file;
    }
    const folder = folderPath(this.settings.eventFolder);
    await this.ensureFolder(folder);
    const base = (folder ? folder + '/' : '') + filename(data['timeline-title']);
    let path = base + '.md', suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = base + ' ' + suffix++ + '.md';
    const title = data['timeline-title'].replace(/\r?\n/g, ' ');
    const content = '---\n' + stringifyYaml(data) + '---\n\n# ' + title + '\n\n## Notes\n\n\n## Sources\n\n';
    this.requireEditing();
    const created = await this.app.vault.create(path, content);
    try {
      await this.mutateData(saved => { saved.previousEventInput = reusableEventInput(result.event, data); }, false);
    } catch (_) {
      // The note already exists; a preferences failure must not offer to create it again.
      this.previousEventInput = reusableEventInput(result.event, data);
      new Notice('Event saved. Previous inputs could not be remembered for the next session.');
    }
    return created;
  }
}

class TimelineView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.state = timelineViewState(); this.navigation = true; this.localNavigations = new Set(); }
  focusSearch() {
    if (!this.cleanup) this.render();
    this.cleanup?.focusSearch();
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Historical timeline'; }
  getIcon() { return 'history'; }
  getState() { return timelineViewState(this.state); }
  navigationKey(state) {
    const mode = state.mode === 'scale' ? 'vertical' : state.mode || 'cards';
    return JSON.stringify([mode, mode === 'vertical' ? state.selected || '' : '',
      mode === 'graph' ? [state.graphSelected || '', state.graphMode || '', state.analysis || '', state.overviewGroup || ''] : []]);
  }
  async setState(state, result) {
    const next = timelineViewState(state);
    const changed = this.navigationKey(this.state) !== this.navigationKey(next);
    const alreadyRendered = this.localNavigations.has(JSON.stringify(next));
    this.state = next;
    if (!alreadyRendered) {
      if (changed && ['vertical','scale'].includes(next.mode)) this.pendingReveal = next.selected;
      this.render();
    }
    await super.setState(next, result);
    // Public Obsidian API: the leaf owns both backward and forward history.
    if (changed) result.history = true;
  }
  async acceptState(state, {navigation = false} = {}) {
    const next = timelineViewState(state);
    if (navigation && this.navigationKey(next) !== this.navigationKey(this.state)) {
      const key = JSON.stringify(next); this.localNavigations.add(key);
      try {
        await this.leaf.setViewState({type:VIEW_TYPE, state:next});
      } catch (error) {
        this.render();
        new Notice('Could not update navigation history: ' + (error.message || String(error)));
      } finally { this.localNavigations.delete(key); }
    } else this.state = next;
    this.app.workspace.requestSaveLayout();
  }
  async onOpen() {
    this.contentEl.classList.add('ht-view-content');
    this.unsubscribe = this.plugin.subscribe(() => this.render()); this.render();

  }
  async onClose() { this.unsubscribe?.(); this.cleanup?.(); this.contentEl.classList.remove('ht-view-content'); }
  render() {
    if (!this.contentEl) return;
    this.cleanup?.();
    const { events, errors } = this.plugin.collect();
    const revealEvent=events.some(event=>event.id===this.pendingReveal)?this.pendingReveal:undefined;
    if(revealEvent)this.pendingReveal=undefined;
    this.cleanup = renderTimeline(this.contentEl, events, {
      isMobile: Boolean(Platform?.isMobile),
      setIcon,
      ...this.plugin.mobileReadingOptions(this.contentEl.ownerDocument),
      chartPreferences: this.plugin.mobileChartPreferences(this.contentEl.ownerDocument),
      bindSearchEscape: (input, exitSearch) => bindSearchEscape(this.plugin.app, input, exitSearch),
      revealEvent,
      ignoreCase: this.plugin.ignoreCase, onIgnoreCaseChange: value => this.plugin.saveIgnoreCase(value),
      onUndated: onSelect => this.plugin.showUndated(onSelect),
      viewOrder: this.plugin.viewOrder, onViewOrderChange: order => this.plugin.saveViewOrder(order),
      analyses: this.plugin.analyses, onAnalysisEdit: (analysis, group, onSaved, seed) => this.plugin.editAnalysis(analysis, group, onSaved, seed),
      initialOverviewGroup: this.state.overviewGroup,
      initialAnalysis: this.state.analysis, initialGraphMode: this.state.graphMode,
      connections: this.plugin.connections, initialSelected: this.state.selected, initialGraphSelected: this.state.graphSelected, initialCollapsed: this.state.collapsed,
      onConnect: (event, connection, direction) => this.plugin.editConnection(event, connection, direction),
      errors, initialGroup: this.state.group, initialGroups: timelineViewState(this.state).groups, initialExcludedTags: timelineViewState(this.state).excludedTags, initialQuery: this.state.query, initialSearchScope: this.state.searchScope, initialCategory: this.state.category, initialMode: this.state.mode, initialTag: this.state.tag, initialMatch: this.state.match, initialImportant: this.state.important, initialCompare: this.state.compare, initialAbove: this.state.above, initialBelow: this.state.below,
      onOpen: event => this.plugin.openEvent(event), onEdit: event => this.plugin.editFromEvent(event),
      onCreate: () => this.plugin.editEvent(undefined, timelineViewState(this.state).groups, event => {
        if(event.start && ['cards','vertical'].includes(this.state.mode || 'cards')){
          this.state.selected=event.id;this.pendingReveal=event.id;
          this.state.query='';this.state.category='';this.state.tag='';this.state.important=false;this.state.match='all';
          if(this.state.groups.length&&!this.state.groups.some(group=>event.groups.includes(group))){this.state.groups=[];this.state.group='';}
          const savedTags=new Set(normalizeTags(event.tags));
          this.state.excludedTags=this.state.excludedTags.filter(tag=>!savedTags.has(tag));
        }
        this.render();
      }),
      onStateChange: (state, change) => this.acceptState(state, change)
    });
    this.state = timelineViewState(this.cleanup?.getState?.() || this.state);
  }
}

class TimelineEmbed extends MarkdownRenderChild {
  constructor(el, plugin, config) { super(el); this.plugin = plugin; this.config = config; this.state = timelineViewState({ query: config.search, mode: config.mode }); }
  onload() { this.unsubscribe = this.plugin.subscribe(() => this.render()); this.render(); }
  onunload() { this.unsubscribe?.(); this.cleanup?.(); }
  render() {
    this.cleanup?.();
    const { events, errors } = this.plugin.collect(this.config);
    this.cleanup = renderTimeline(this.containerEl, events, {
      isMobile: Boolean(Platform?.isMobile),
      setIcon,
      ...this.plugin.mobileReadingOptions(this.containerEl.ownerDocument),
      chartPreferences: this.plugin.mobileChartPreferences(this.containerEl.ownerDocument),
      bindSearchEscape: (input, exitSearch) => bindSearchEscape(this.plugin.app, input, exitSearch),
      ignoreCase: this.plugin.ignoreCase, onIgnoreCaseChange: value => this.plugin.saveIgnoreCase(value),
      onUndated: onSelect => this.plugin.showUndated(onSelect),
      viewOrder: this.plugin.viewOrder, onViewOrderChange: order => this.plugin.saveViewOrder(order),
      analyses: (this.plugin.analyses || []).filter(item => !this.config.timeline || (item.groups || []).includes(this.config.timeline)), onAnalysisEdit: (analysis, group, onSaved, seed) => this.plugin.editAnalysis(analysis, group, onSaved, seed),
      initialOverviewGroup: this.state.overviewGroup,
      initialAnalysis: this.state.analysis, initialGraphMode: this.state.graphMode,
      connections: this.plugin.connections, initialSelected: this.state.selected, initialGraphSelected: this.state.graphSelected, initialCollapsed: this.state.collapsed,
      embedded: true, title: this.config.title || this.config.timeline || 'Historical timeline', errors,
      initialGroup: this.state.group, initialGroups: timelineViewState(this.state).groups, initialExcludedTags: timelineViewState(this.state).excludedTags, initialQuery: this.state.query, initialSearchScope: this.state.searchScope, initialCategory: this.state.category, initialMode: this.state.mode, initialTag: this.state.tag, initialMatch: this.state.match, initialImportant: this.state.important, initialCompare: this.state.compare, initialAbove: this.state.above, initialBelow: this.state.below,
      onOpen: event => this.plugin.openEvent(event), onEdit: event => this.plugin.editFromEvent(event),
      onStateChange: state => { this.state = timelineViewState(state); }
    });
    this.state = timelineViewState(this.cleanup?.getState?.() || this.state);
  }
}

class ReadingPreviewModal extends Modal {
  constructor(app, plugin, event, renderPanel) {
    super(app); this.plugin = plugin; this.event = event; this.renderPanel = renderPanel;
  }
  onOpen() { this.show(this.event, this.renderPanel); }
  show(event, renderPanel) {
    this.event = event; this.renderPanel = renderPanel;
    this.contentEl.replaceChildren();
    const panel = element(this.contentEl, 'article', 'ht-root ht-reading-preview');
    panel.setAttribute('aria-label', 'Event details: ' + event.title);
    renderPanel(panel);
    const close = element(panel, 'button', 'ht-button ht-secondary', 'Close details');
    close.type = 'button'; close.addEventListener('click', () => this.close());
    this.contentEl.scrollTop = 0;
  }
  onClose() {
    if (this.plugin.readingPreview === this) this.plugin.readingPreview = null;
    this.contentEl.replaceChildren();
  }
}

class UndatedModal extends Modal {
  constructor(app, plugin, onSelect) { super(app); this.plugin = plugin; this.onSelect = onSelect; }
  onOpen() {
    this.contentEl.classList.add('ht-editor'); element(this.contentEl, 'h2', '', 'Undated events');
    const search = element(this.contentEl, 'input', 'ht-field-input'); search.placeholder='Search undated events and abstract factors';
    const list = element(this.contentEl, 'div', '');
    const render = () => {
      list.replaceChildren();
      const events = this.plugin.collect().events.filter(event => !event.start && [event.title,...(event.aliases||[])].some(name=>searchText(name).toLocaleLowerCase().includes(searchText(search.value).toLocaleLowerCase())));
      if (!events.length) element(list, 'p', '', 'No undated events match.');
      for (const event of events) {
        const row=element(list,'div','ht-undated-row');
        const button=element(row,'button','ht-type-suggestion',event.title);button.type='button';
        button.addEventListener('click',()=>{
          this.close();
          if(this.plugin.isReadingMode()) this.onSelect?.(event);
          else this.plugin.editFromEvent(event);
        });
        if(!this.plugin.isReadingMode()) {
          const connect=element(row,'button','','Connect');connect.type='button';
          connect.addEventListener('click',()=>{this.close();this.plugin.editConnection(event);});
        }
      }
    };
    search.addEventListener('input',render);render();
  }
  onClose(){this.contentEl.replaceChildren();}
}

// All form editors share the same modal-local save shortcut and cleanup.
class EditorModal extends Modal {
  bindSearchEscape(input, exitSearch, focusRoot = input) {
    const release = bindSearchEscape(this.app, input, exitSearch, this.scope, focusRoot);
    (this.searchCleanups ||= new Set()).add(release);
    return () => { release(); this.searchCleanups.delete(release); };
  }
  bindSaveShortcut(form, save) {
    if (this.saveHotkey) this.scope.unregister(this.saveHotkey);
    save.title = 'Command+Enter on Mac · Ctrl+Enter on Windows/Linux';
    this.saveHotkey = this.scope.register(['Mod'], 'Enter', event => {
      if (event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat && !save.disabled) form.requestSubmit(save);
      return false;
    });
  }
  onClose() {
    for (const release of this.searchCleanups || []) release();
    this.searchCleanups?.clear();
    if (this.saveHotkey) { this.scope.unregister(this.saveHotkey); this.saveHotkey = null; }
    this.contentEl.replaceChildren();
  }
}

// Analysis diagrams are separate from historical events and their saved connections.
class AnalysisModal extends EditorModal {
  constructor(app, plugin, previous, group, onSaved, seed) { super(app); this.plugin=plugin; this.previous=previous; this.groups=timelineGroups(group); this.onSaved=onSaved; this.seed=seed; }
  onOpen() {
    this.contentEl.classList.add('ht-editor');
    this.contentEl.classList.add('ht-analysis-editor');
    const draft=JSON.parse(JSON.stringify(this.previous || this.seed || {title:'',groups:this.groups,headEventId:'',branches:[]}));
    const events=this.plugin.collect().events;
    element(this.contentEl,'h2','',this.previous?'Edit fishbone analysis':'New fishbone analysis');
    element(this.contentEl,'p','ht-editor-intro','Name the outcome or question, then add events or your own arguments along each branch.');
    const form=element(this.contentEl,'form','ht-event-form');
    const keepScroll = callback => preserveEditorScroll(this.contentEl,callback);
    const field=(parent,title,value,change,multiline=false)=>{
      const label=element(parent,'label','ht-field');element(label,'span','ht-field-label',title);
      const input=element(label,multiline?'textarea':'input','ht-field-input');input.value=value||'';input.setAttribute('aria-label',title);
      input.addEventListener('input',()=>change(input.value));return input;
    };
    const action=(parent,title,callback)=>{const button=element(parent,'button','ht-analysis-action',title);button.type='button';button.addEventListener('click',callback);return button;};
    const eventPicker=(parent,title,id,change,attachLabel)=>{
      let selected=id||'';
      const picker=element(parent,'div','ht-analysis-event-picker');
      const attachment=element(picker,'div','ht-analysis-attachment');
      const name=element(attachment,'span','ht-analysis-attached-name');
      const search=element(picker,'div','ht-analysis-event-search');search.hidden=true;
      const input=field(search,title,'',()=>{});input.placeholder='Search events or aliases…';
      const sync=()=>{
        const event=events.find(event=>event.id===selected);
        attachment.hidden=!selected;clear.hidden=!selected;attach.hidden=Boolean(selected);
        name.textContent=event?event.title:(selected?'Attached event unavailable':'');
        name.title=event?.start?.label||'';
      };
      const showSearch=()=>keepScroll(()=>{search.hidden=false;input.value='';input.focus({preventScroll:true});});
      const changeButton=action(attachment,'Change event',showSearch);
      const clear=action(attachment,'Clear attached event',()=>keepScroll(()=>{
        selected='';input.value='';change('');search.hidden=true;completer.hide();sync();attach.focus({preventScroll:true});
      }));
      const attach=action(picker,attachLabel,showSearch);
      const completer=attachSuggestions(input,query=>matchingSuggestions(events,query,event=>[event.title,...(event.aliases||[])],{fuzzy:true}).map(event=>({label:event.title+' · '+(event.start?.label||'Undated'),event})),choice=>{
        selected=choice.event.id;input.value=choice.event.title;change(selected);search.hidden=true;sync();return changeButton;
      });
      action(search,'Cancel search',()=>keepScroll(()=>{search.hidden=true;completer.hide();(selected?changeButton:attach).focus({preventScroll:true});}));
      sync();return picker;
    };
    field(form,'Outcome / question at the head',draft.title,value=>draft.title=value);
    eventPicker(form,'Head event (optional)',draft.headEventId,value=>{draft.headEventId=value;},'Attach head event');
    const outcomePickers=new Set();
    const causalLabel=element(form,'label','ht-importance-field');const causal=element(causalLabel,'input','');causal.type='checkbox';causal.checked=Boolean(draft.causal);element(causalLabel,'span','','Show saved causal arrows and order events toward the spine');causal.addEventListener('change',()=>keepScroll(()=>{draft.causal=causal.checked;for(const picker of outcomePickers)picker.hidden=causal.checked;}));
    const groups=field(form,'Timelines (one name per line)',draft.groups.join('\n'),value=>draft.groups=value.split('\n'),true);
    const knownGroups=[...new Set(events.flatMap(event=>event.groups||[]))];
    attachSuggestions(groups,query=>matchingSuggestions(knownGroups,query).filter(value=>{const active=groups.value.slice(0,groups.selectionStart??groups.value.length).split('\n').length-1;const other=groups.value.split('\n').filter((line,index)=>index!==active).map(line=>line.trim().toLocaleLowerCase());return !other.includes(value.toLocaleLowerCase());}).map(value=>({label:value,value})),(choice,start,end)=>{groups.value=groups.value.slice(0,start)+choice.value+groups.value.slice(end);draft.groups=groups.value.split('\n');},()=>{const caret=groups.selectionStart??groups.value.length;return [groups.value.lastIndexOf('\n',caret-1)+1,groups.value.indexOf('\n',caret)<0?groups.value.length:groups.value.indexOf('\n',caret)];});
    const branchHost=element(form,'div','ht-analysis-branches');
    const renderBranch = (branch, expanded = false) => {
      const card=element(branchHost,'details','ht-analysis-branch-editor');
      card.open=expanded;
      const summary=element(card,'summary','ht-analysis-branch-summary');
      const branchName=element(summary,'span','',branch.title||'New branch');
      const count=element(summary,'span','ht-analysis-count');
      const updateCount=()=>{const n=branch.factors.length;count.textContent=`${n} ${n===1?'factor':'factors'}`;};updateCount();
      const body=element(card,'div','ht-analysis-branch-body');
      const rename=element(body,'div','ht-analysis-rename');rename.hidden=Boolean(branch.title);
      const heading=field(rename,'Branch heading',branch.title,value=>{branch.title=value;branchName.textContent=value||'New branch';});
      const headings=[...new Set((this.plugin.analyses||[]).flatMap(item=>item.branches||[]).map(item=>item.title))];
      attachSuggestions(heading,query=>matchingSuggestions(headings,query).map(value=>({label:value,value})),choice=>{heading.value=choice.value;branch.title=choice.value;branchName.textContent=choice.value;});
      const renameButton=action(body,'Rename branch',()=>keepScroll(()=>{rename.hidden=false;renameButton.hidden=true;heading.focus({preventScroll:true});}));renameButton.hidden=!rename.hidden;
      action(rename,'Done',()=>keepScroll(()=>{if(!branch.title.trim())return heading.focus({preventScroll:true});rename.hidden=true;renameButton.hidden=false;renameButton.focus({preventScroll:true});}));
      const outcome=eventPicker(body,'Branch outcome (optional)',branch.eventId,value=>branch.eventId=value,'Attach branch outcome');outcome.hidden=Boolean(draft.causal);outcomePickers.add(outcome);
      const factors=element(body,'div','ht-analysis-factor-list');
      const renderFactor = (factor, expanded = false) => {
        const row=element(factors,'details','ht-analysis-factor-editor');row.open=expanded;
        const summary=element(row,'summary','ht-analysis-factor-summary');
        const updateTitle=()=>summary.textContent=factor.title||events.find(event=>event.id===factor.eventId)?.title||'New factor';updateTitle();
        const content=element(row,'div','ht-analysis-factor-body');
        const title=field(content,'Factor / argument',factor.title,value=>{factor.title=value;updateTitle();});
        eventPicker(content,'Supporting event (optional)',factor.eventId,value=>{
          factor.eventId=value;
          if(value&&!factor.title?.trim()){factor.title=events.find(event=>event.id===value)?.title||'';title.value=factor.title;}
          updateTitle();
        },'Attach supporting event');
        const roleLabel=element(content,'label','ht-field');element(roleLabel,'span','ht-field-label','Role in the explanation');
        const role=element(roleLabel,'select','ht-field-input');role.setAttribute('aria-label','Role in the explanation');
        for(const value of ['Contributing factor','Background condition','Trigger','Enabling factor','Counterargument']) {const option=element(role,'option','',value);option.value=value;}
        role.value=factor.role||'Contributing factor';role.addEventListener('change',()=>factor.role=role.value);
        field(content,'How it contributed',factor.explanation,value=>factor.explanation=value,true);
        const evidence=element(content,'details','ht-analysis-evidence');
        const evidenceSummary=element(evidence,'summary','','Sources & perspectives');
        const updateEvidence=()=>evidenceSummary.textContent='Sources & perspectives'+(factor.source||factor.perspectives||factor.disputed?' · Added':'');updateEvidence();
        const evidenceBody=element(evidence,'div','ht-analysis-evidence-body');
        const source=field(evidenceBody,'Source / citation',factor.source,value=>{factor.source=value;updateEvidence();});
        const sources=[...new Set([...reusableSources(events,this.plugin.connections), ...(this.plugin.analyses||[]).flatMap(item=>item.branches||[]).flatMap(item=>item.factors||[]).map(item=>item.source).filter(Boolean)])];
        attachSuggestions(source,query=>matchingSuggestions(sources,query).map(value=>({label:value,value})),choice=>{source.value=choice.value;factor.source=choice.value;updateEvidence();});
        field(evidenceBody,'Historians’ perspectives (one interpretation per paragraph)',factor.perspectives,value=>{factor.perspectives=value;updateEvidence();},true);
        const disputedLabel=element(evidenceBody,'label','ht-importance-field');const disputed=element(disputedLabel,'input','');disputed.type='checkbox';disputed.checked=Boolean(factor.disputed);element(disputedLabel,'span','','Disputed interpretation');disputed.addEventListener('change',()=>{factor.disputed=disputed.checked;updateEvidence();});
        const remove=action(content,'Remove factor',()=>keepScroll(()=>{branch.factors.splice(branch.factors.indexOf(factor),1);row.remove();updateCount();addFactor.focus({preventScroll:true});}));remove.classList.add('ht-analysis-remove');
        return title;
      };
      branch.factors.forEach(factor=>renderFactor(factor));
      const eventSearch=element(body,'div','ht-analysis-add-event-search');eventSearch.hidden=true;
      const eventInput=field(eventSearch,'Find an event for this branch','',()=>{});
      eventInput.placeholder='Search events or aliases…';
      const eventStatus=element(eventSearch,'p','ht-editor-intro');eventStatus.setAttribute('aria-live','polite');
      let lastAdded='';
      const alreadyAdded=id=>branch.eventId===id||branch.factors.some(factor=>factor.eventId===id);
      const eventCompleter=attachSuggestions(eventInput,query=>{
        const available=events.filter(event=>!alreadyAdded(event.id));
        const matches=matchingSuggestions(available,query,event=>[event.title,...(event.aliases||[])],{fuzzy:true});
        eventStatus.textContent=!available.length?'All available events are already on this branch.':query&&!matches.length?'No matching events. Try another name or alias.':!query&&lastAdded?'Added '+lastAdded+'. Search to add another event.':'';
        return matches.map(event=>({label:event.title+' · '+(event.start?.label||'Undated'),event}));
      },choice=>{
        if(alreadyAdded(choice.event.id))return eventInput;
        const factor={title:choice.event.title,eventId:choice.event.id,role:'Contributing factor'};
        branch.factors.push(factor);renderFactor(factor);updateCount();
        eventInput.value='';lastAdded=choice.event.title;
        eventStatus.textContent='Added '+choice.event.title+'. Search to add another event.';
        return eventInput;
      });
      const closeEventSearch=()=>keepScroll(()=>{
        eventSearch.hidden=true;eventInput.value='';eventCompleter.hide();addEvent.hidden=false;addEvent.focus({preventScroll:true});
      });
      action(eventSearch,'Cancel adding events',closeEventSearch);
      const releaseEventSearch=this.bindSearchEscape(eventInput,event=>{
        if(event.isComposing||eventSearch.hidden)return false;
        event.preventDefault();event.stopPropagation();closeEventSearch();return true;
      },eventSearch);
      const branchActions=element(body,'div','ht-analysis-branch-actions');
      const addEvent=action(branchActions,'Add event',()=>keepScroll(()=>{
        eventSearch.hidden=false;addEvent.hidden=true;eventInput.value='';lastAdded='';eventInput.focus({preventScroll:true});
      }));addEvent.classList.add('mod-cta');
      const addFactor=action(branchActions,'Add factor',()=>keepScroll(()=>{
        const factor={title:'',eventId:'',role:'Contributing factor'};branch.factors.push(factor);
        renderFactor(factor,true).focus({preventScroll:true});updateCount();
      }));
      action(branchActions,'Remove branch',()=>keepScroll(()=>{releaseEventSearch();draft.branches.splice(draft.branches.indexOf(branch),1);outcomePickers.delete(outcome);card.remove();addBranch.focus({preventScroll:true});})).classList.add('ht-analysis-remove');
      return heading;
    };
    draft.branches.forEach((branch,index)=>renderBranch(branch,index===0));
    const addBranch=action(form,'Add branch',()=>keepScroll(()=>{const branch={title:'',factors:[]};draft.branches.push(branch);renderBranch(branch,true).focus({preventScroll:true});}));
    const error=element(form,'p','ht-form-error');error.setAttribute('role','alert');
    const actions=element(form,'div','ht-editor-actions');action(actions,'Cancel',()=>this.close());
    const save=element(actions,'button','mod-cta','Save analysis');save.type='submit';
    this.bindSaveShortcut(form, save);
    let remove;
    if(this.previous){let confirmed=false;remove=action(actions,'Remove analysis',async()=>{
      if(!confirmed){confirmed=true;remove.textContent='Confirm removal';return;}
      if(save.disabled)return;save.disabled=true;remove.disabled=true;
      try{await this.plugin.deleteAnalysis(this.previous);this.close();}catch(e){error.textContent=e.message;}finally{save.disabled=false;remove.disabled=false;}
    });}
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(save.disabled)return;save.disabled=true;if(remove)remove.disabled=true;
      try{const saved=await this.plugin.saveAnalysis(draft,this.previous);this.close();this.onSaved?.(saved);}catch(e){error.textContent=e.message;}finally{save.disabled=false;if(remove)remove.disabled=false;}
    });
  }
}

class ConnectionModal extends EditorModal {
  constructor(app, plugin, event, connection, direction) { super(app); this.plugin = plugin; this.event = event; this.connection = connection; this.direction = direction; }
  open() {
    super.open();
    // Obsidian sets its initial modal focus after onOpen returns.
    this.focusEndpoint?.();
  }
  onOpen() {
    this.contentEl.classList.add('ht-editor');
    const events = this.plugin.collect().events;
    element(this.contentEl, 'h2', '', this.connection ? 'Edit connection' : 'Connect events');
    const form = element(this.contentEl, 'form', 'ht-event-form');
    const fields = {};
    const endpoints = {};
    let activeCompleter = null;
    const trackCompleter = (input, completer) => {
      const activate = () => { activeCompleter = completer; };
      input.addEventListener('focus', activate); input.addEventListener('input', activate);
      return completer;
    };
    const ignoreLabel = element(form, 'label', 'ht-importance-field'); const ignore = element(ignoreLabel, 'input', ''); ignore.type = 'checkbox'; ignore.checked = this.plugin.ignoreCase !== false; element(ignoreLabel, 'span', '', 'Ignore case');
    ignore.addEventListener('change', async () => {
      const value = ignore.checked;
      activeCompleter?.refresh();
      ignore.disabled = true;
      try { await this.plugin.saveIgnoreCase(value); }
      catch (error) { ignore.checked = !value; activeCompleter?.refresh(); new Notice(error.message); }
      finally { ignore.disabled = false; }
    });
    const defaultSide = this.direction === 'incoming' ? 'to' : 'from';
    for (const [key, title] of [['from', 'Cause / contributing event'], ['to', 'Effect / related event']]) {
      const label = element(form, 'label', 'ht-field'); element(label, 'span', 'ht-field-label', title);
      const input = element(label, 'input', 'ht-field-input'); input.placeholder = 'Find an event or type a new event / abstract factor'; input.setAttribute('aria-label', title);
      const chosenId = this.connection?.[key] || (key === defaultSide ? this.event.id : '');
      const chosen = events.find(event => event.id === chosenId);
      input.value = chosen?.title || '';
      const endpoint = { id: chosenId, newTitle:'', input }; endpoints[key] = endpoint;
      const status = element(label, 'span', 'ht-field-hint', chosen ? 'Selected: ' + chosen.title : '');
      const date = element(label, 'input', 'ht-field-input'); date.placeholder = 'Optional date; leave blank if unknown'; date.hidden = true; date.setAttribute('aria-label', 'New ' + key + ' event date'); endpoint.date = date;
      input.addEventListener('input', () => { endpoint.id=''; endpoint.newTitle=''; date.hidden=true; status.textContent=''; });
      const completer = attachSuggestions(input, query => {
        const otherId = endpoints[key === 'from' ? 'to' : 'from']?.id;
        const matches = matchingSuggestions(events.filter(event => event.id !== otherId),query,event=>[event.title,...(event.aliases||[])],{ignoreCase:ignore.checked,fuzzy:true}).map(event => ({label:event.title + ' · ' + (event.kind==='factor'?'Abstract factor':event.start?.label || 'Undated'),event}));
        const canCreate = query && !events.some(event => [event.title,...(event.aliases||[])].some(name=>name.toLocaleLowerCase() === query.toLocaleLowerCase()));
        const choices = matches.slice(0, canCreate ? 8 : 10);
        if (canCreate) choices.push({label:'Create new event: ' + query, newTitle:query}, {label:'Create abstract factor: ' + query, newTitle:query,kind:'factor'});
        return choices;
      }, choice => {
        if (choice.event) { endpoint.id=choice.event.id; endpoint.newTitle=''; input.value=choice.event.title; date.hidden=true; status.textContent='Selected: '+choice.event.title; }
        else { endpoint.id=''; endpoint.newTitle=choice.newTitle; endpoint.kind=choice.kind||'event'; input.value=choice.newTitle;date.value='';date.hidden=endpoint.kind==='factor'; status.textContent=endpoint.kind==='factor'?'Abstract factor — no date or note required; created when this connection is saved':'New event — date optional; created when this connection is saved'; }
      });
      endpoint.completer = trackCompleter(input, completer);
    }
    for (const [key, title, placeholder] of [['relation', 'Relationship', 'contributed to, prompted, enabled…'], ['explanation', 'Explanation', 'How are these events connected?'], ['source', 'Source / citation', 'Evidence supporting this interpretation']]) {
      const label = element(form, 'label', 'ht-field'); element(label, 'span', '', title);
      const input = element(label, key === 'explanation' ? 'textarea' : 'input', 'ht-field-input'); input.value = this.connection?.[key] || ''; input.placeholder = placeholder; fields[key] = input;
    }
    for (const key of ['relation', 'source']) {
      const values = [...new Set([...(this.plugin.connections || []).map(link=>link[key]), ...(key==='source'?reusableSources(events,this.plugin.connections):['contributed to','prompted','enabled','triggered','response to'])].filter(Boolean))];
      trackCompleter(fields[key], attachSuggestions(fields[key], query => matchingSuggestions(values,query,value=>value,{ignoreCase:ignore.checked}).map(value=>({label:value,value})), choice=>{fields[key].value=choice.value;}));
    }
    const disputedLabel = element(form, 'label', 'ht-importance-field');
    const disputed = element(disputedLabel, 'input', ''); disputed.type = 'checkbox'; disputed.checked = Boolean(this.connection?.disputed); element(disputedLabel, 'span', '', 'Disputed interpretation');
    const error = element(form, 'p', 'ht-form-error'); error.setAttribute('role', 'alert');
    const actions = element(form, 'div', 'ht-editor-actions');
    const cancel = element(actions, 'button', '', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.close());
    const save = element(actions, 'button', 'mod-cta', 'Save connection'); save.type = 'submit';
    this.bindSaveShortcut(form, save);
    let remove;
    if (this.connection) {
      remove = element(actions, 'button', '', 'Remove connection'); remove.type = 'button'; let confirmed = false;
      remove.addEventListener('click', async () => {
        if (!confirmed) { confirmed = true; remove.textContent = 'Confirm removal'; return; }
        if (save.disabled) return; save.disabled = true; remove.disabled = true;
        try { await this.plugin.deleteConnection(this.connection); this.close(); } catch (e) { error.textContent = e.message; } finally { save.disabled = false; remove.disabled = false; }
      });
    }
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (save.disabled) return; save.disabled = true;
      try { await this.plugin.saveConnection({ ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])), ...Object.fromEntries(Object.entries(endpoints).flatMap(([key, endpoint]) => endpoint.newTitle ? [[key + 'New', {title:endpoint.newTitle,kind:endpoint.kind,date:endpoint.date.value,groups:this.event.groups || []}]] : [[key,endpoint.id]])), disputed: disputed.checked }, this.connection); this.close(); }
      catch (e) { error.textContent = e.message; } finally { save.disabled = false; }
    });
    const first = endpoints[defaultSide === 'from' ? 'to' : 'from'];
    this.focusEndpoint = () => { first.input.focus({preventScroll:true}); activeCompleter = first.completer; first.completer.refresh(); };
  }
  onClose() { this.focusEndpoint = null; super.onClose(); }
}

class EventModal extends EditorModal {
  constructor(app, plugin, file, group, standalone, onSaved) { super(app); this.plugin = plugin; this.file = file; this.groups = timelineGroups(group); this.standalone = standalone; this.onSaved=onSaved; }
  onOpen() {
    const fm = this.file ? this.app.metadataCache.getFileCache(this.file)?.frontmatter || {} : this.standalone?.properties || {};
    this.snapshot = this.standalone ? JSON.stringify(this.standalone) : fieldsSnapshot(fm);
    const editing = Boolean(this.file || this.standalone);
    const text = key => typeof fm[key] === 'string' || typeof fm[key] === 'number' ? String(fm[key]) : '';
    this.contentEl.classList.add('ht-editor');
    element(this.contentEl, 'h2', '', editing ? 'Edit timeline event' : 'Add a historical event');
    element(this.contentEl, 'p', 'ht-editor-intro', this.file ? 'Updates the timeline properties in this note. Your note text stays intact.' : this.standalone ? 'This event is saved in your timeline without a separate note.' : 'Add an event to your timeline. Creating a separate note is optional.');
    const form = element(this.contentEl, 'form', 'ht-event-form');
    let storage = null;
    if (!editing) {
      const field = element(form, 'label', 'ht-field');
      element(field, 'span', 'ht-field-label', 'Save event as');
      storage = element(field, 'select', 'ht-field-input');
      storage.setAttribute('aria-label', 'Save event as');
      for (const [value, label] of [['timeline', 'Timeline only (no new note)'], ['note', 'Create a Markdown note']]) {
        const option = element(storage, 'option', '', label); option.value = value;
      }
      storage.value = 'timeline';
      const help = element(form, 'p', 'ht-field-hint', 'Save the event directly in your timeline.');
      storage.addEventListener('change', () => {
        help.textContent = storage.value === 'note' ? 'Create a linked note in ' + (this.plugin.settings.eventFolder || 'the vault root') + '.' : 'Save the event directly in your timeline.';
      });
    }
    const inputs = {};
    const add = (key, label, value, placeholder, multiline = false) => {
      const field = element(form, 'label', 'ht-field');
      element(field, 'span', 'ht-field-label', label);
      const input = element(field, multiline ? 'textarea' : 'input', 'ht-field-input');
      if (!multiline) input.type = 'text'; else input.rows = 3;
      input.value = value; input.placeholder = placeholder || ''; inputs[key] = input; return input;
    };
    add('timeline-title', 'Event title', text('timeline-title') || this.file?.basename || '', 'Name this event').required = true;
    const aliasToggle = element(form, 'button', 'ht-alias-toggle'); aliasToggle.type = 'button';
    const aliases = add('aliases', 'Aliases (one name per line)', normalizeAliases(fm.aliases).join('\n'), 'Alternative names or abbreviations', true);
    const aliasField = aliases.parentElement; aliasField.hidden = true;
    const updateAliasToggle = () => {
      const count = normalizeAliases(aliases.value).length;
      aliasToggle.textContent = aliasField.hidden ? (count ? `Edit aliases (${count})` : 'Add aliases') : 'Hide aliases';
      aliasToggle.setAttribute('aria-expanded', String(!aliasField.hidden));
    };
    aliasToggle.addEventListener('click', () => preserveEditorScroll(this.contentEl, () => {
      aliasField.hidden = !aliasField.hidden;
      updateAliasToggle();
      if (!aliasField.hidden) aliases.focus({preventScroll:true});
      else aliasToggle.focus({preventScroll:true});
    }));
    aliases.addEventListener('input', updateAliasToggle);
    updateAliasToggle();
    const timeField = element(form, 'label', 'ht-field');
    element(timeField, 'span', 'ht-field-label', 'Time type');
    const timeType = element(timeField, 'select', 'ht-field-input');
    timeType.setAttribute('aria-label', 'Time type');
    for (const [value, label] of [['specific', 'Specific time'], ['period', 'Period / decade / century'], ['undated', 'Unknown / not yet dated'], ['factor', 'Abstract factor / outcome (no date)']]) {
      const option = element(timeType, 'option', '', label); option.value = value;
    }
    timeType.value = fm['timeline-kind']==='factor' ? 'factor' : fm['timeline-undated'] === true ? 'undated' : text('timeline-end') || /(?:s|century)(?:\s+(?:BCE|BC|CE|AD))?$/i.test(text('timeline-date')) ? 'period' : 'specific';
    const start = add('timeline-date', 'Start date', text('timeline-date'), '1930s · 221 BCE · 1911-10-10'); start.required = true;
    const end = add('timeline-end', 'End date', text('timeline-end'), 'Leave blank for a decade or century, e.g. 1920s or 19th century');
    const updateTimeType = () => { start.disabled = ['undated','factor'].includes(timeType.value); start.required = !start.disabled; start.parentElement.hidden = start.disabled; end.disabled = timeType.value !== 'period'; end.parentElement.style.display = end.disabled ? 'none' : ''; };
    let autoPeriod=false;
    const detectTimeType=()=>{
      if(['undated','factor'].includes(timeType.value))return;
      let parsed;
      try { parsed=parseHistoricalDate(start.value); } catch (_) { return; } // Wait for a complete date while typing.
      if(['decade','century'].includes(parsed.precision)&&timeType.value==='specific'){
        timeType.value='period';autoPeriod=true;updateTimeType();
      }else if(!['decade','century'].includes(parsed.precision)&&autoPeriod&&!end.value.trim()){
        timeType.value='specific';autoPeriod=false;updateTimeType();
      }
    };
    timeType.addEventListener('change',()=>{autoPeriod=false;updateTimeType();detectTimeType();}); updateTimeType();
    start.addEventListener('input',event=>{if(!event.isComposing)preserveEditorScroll(this.contentEl,detectTimeType);});
    start.addEventListener('compositionend',()=>preserveEditorScroll(this.contentEl,detectTimeType));
    start.addEventListener('blur',()=>preserveEditorScroll(this.contentEl,detectTimeType));
    element(form, 'p', 'ht-field-hint', 'Centuries (19th century or 5th century BCE), decades (1930s or 40s BCE), years, year-months, and full dates are supported. Use BCE / CE or BC / AD; there is no year zero. Approximate dates use c.');
    const reuseRefreshers = new Map();
    const groups = Array.isArray(fm.timeline) ? fm.timeline.filter(x => typeof x === 'string').join('\n') : text('timeline');
    add('timeline', 'Timelines (one name per line)', editing ? groups : this.groups.join('\n'), 'Chinese history\nWorld history', true);
    add('timeline-category', 'Category', text('timeline-category'), 'Politics, Culture, Science…');
    add('timeline-tags', 'Tags (comma or space separated)', normalizeTags(fm['timeline-tags']).join(', '), 'war, diplomacy, china/modern');
    for (const [key, label, value] of [
      ['timeline', 'timelines', previous => previous.timelines.join('\n')],
      ['timeline-category', 'category', previous => previous.category],
      ['timeline-tags', 'tags', previous => previous.tags.join(', ')]
    ]) {
      const row = element(inputs[key].parentElement, 'div', 'ht-previous-row');
      const reuse = element(row, 'button', 'ht-reuse-previous', 'Use previous ' + label);
      const previousValue = previousEventInput(this.plugin.previousEventInput);
      const preview = element(row, 'span', 'ht-previous-value', previousValue ? (value(previousValue).replace(/\n/g, ' · ') || '(empty)') : 'No previous event yet');
      preview.setAttribute('aria-label', 'Previous ' + label);
      reuse.type = 'button';
      reuse.disabled = !previousEventInput(this.plugin.previousEventInput);
      reuse.title = reuse.disabled ? 'Available after you create an event.' : 'Use ' + label + ' from your last successfully created event.';
      reuse.addEventListener('click', () => {
        const previous = previousEventInput(this.plugin.previousEventInput);
        if (!previous) return;
        preserveEditorScroll(this.contentEl, () => {
          inputs[key].value = value(previous);
          reuseRefreshers.get(key)?.();
        });
      });
    }
    const importanceLabel = element(form, 'label', 'ht-importance-field');
    const important = element(importanceLabel, 'input', ''); important.type = 'checkbox';
    important.checked = fm['timeline-important'] === true;
    important.setAttribute('aria-label', 'Highlight as important');
    element(importanceLabel, 'span', '', 'Highlight as important');
    add('timeline-summary', 'Summary', text('timeline-summary'), 'Why this event matters', true).rows = 6;
    add('timeline-location', 'Location', text('timeline-location'), 'Place or region');
    add('timeline-source', 'Source / citation', text('timeline-source'), 'Book, page, URL, or [[source note]]', true);
    const previousEvents = this.plugin.collect().events;
    const sources = reusableSources(previousEvents,this.plugin.connections);
    const perspectives = element(form, 'section', 'ht-perspectives-editor');
    element(perspectives, 'h3', '', 'Historical perspectives');
    const perspectiveRows = [];
    const addPerspective = (value = {}) => {
      const card = element(perspectives, 'div', 'ht-perspective-card'); const row = {};
      for (const [key, title] of [['historian','Historian'], ['interpretation','Perspective / interpretation'], ['source','Source / citation']]) {
        const label = element(card, 'label', 'ht-field'); element(label, 'span', 'ht-field-label', title);
        row[key] = element(label, key === 'interpretation' ? 'textarea' : 'input', 'ht-field-input'); row[key].value = value[key] || '';
      }
      for (const [key, values] of [['historian',previousEvents.flatMap(event => (event.perspectives || []).map(item => item.historian))], ['source',sources]]) {
        const choices = [...new Set(values.filter(Boolean))];
        attachSuggestions(row[key], query => matchingSuggestions(choices,query).map(value=>({label:value,value})), choice=>{row[key].value=choice.value;});
      }
      const remove = element(card, 'button', '', 'Remove perspective'); remove.type = 'button';
      remove.addEventListener('click', () => preserveEditorScroll(this.contentEl,()=>{ perspectiveRows.splice(perspectiveRows.indexOf(row), 1); card.remove(); }));
      perspectiveRows.push(row);
    };
    for (const value of Array.isArray(fm['timeline-perspectives']) ? fm['timeline-perspectives'] : []) addPerspective(value);
    const addPerspectiveButton = element(form, 'button', '', 'Add historian perspective'); addPerspectiveButton.type = 'button'; addPerspectiveButton.addEventListener('click', () => preserveEditorScroll(this.contentEl,()=>addPerspective()));
    const duplicateBox = element(inputs['timeline-title'].parentElement, 'div', 'ht-duplicate-events');
    inputs['timeline-title'].addEventListener('input', () => {
      duplicateBox.replaceChildren(); const query = inputs['timeline-title'].value.trim().toLocaleLowerCase();
      if (!query) return;
      const ownId = this.standalone ? 'timeline:' + this.standalone.id : this.file?.path;
      const matches = matchingSuggestions(previousEvents.filter(event => event.id !== ownId),query,event=>[event.title,...(event.aliases||[])],{fuzzy:true}).slice(0,5);
      if (matches.length) element(duplicateBox, 'p', 'ht-field-hint', 'Similar events already exist. You can edit one instead:');
      for (const event of matches) {
        const button = element(duplicateBox, 'button', 'ht-type-suggestion', 'Edit: ' + event.title); button.type = 'button';
        button.addEventListener('click', () => { this.close(); this.plugin.editFromEvent(event); });
      }
    });

    const reusable = [
      ['timeline', 'timeline', previousEvents.flatMap(event => event.groups || []), 'lines'],
      ['timeline-category', 'category', previousEvents.map(event => event.category).filter(value => value !== 'Uncategorized'), 'single'],
      ['timeline-tags', 'tag', previousEvents.flatMap(event => event.tags || []), 'tags'],
      ['timeline-location', 'location', previousEvents.map(event => event.location), 'single'],
      ['timeline-source', 'source', sources, 'single'],
    ];
    for (const [key, label, values, mode] of reusable) {
      const choices = [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].sort((a, b) => a.localeCompare(b));
      if (!choices.length) continue;
      const input = inputs[key];
      const tokenBounds = () => {
        const cursor = input.selectionStart ?? input.value.length;
        if (mode === 'single') return [0, input.value.length];
        const delimiter = mode === 'lines' ? /[\r\n]/ : /[\s,]/;
        let start = cursor, end = cursor;
        while (start > 0 && !delimiter.test(input.value[start - 1])) start--;
        while (end < input.value.length && !delimiter.test(input.value[end])) end++;
        return [start, end];
      };
      const suggestions = attachSuggestions(input, query => {
        const normalized = query.replace(mode === 'tags' ? /^#+/ : /^$/, '').toLocaleLowerCase();
        const [start,end]=tokenBounds();
        const others=mode==='lines'?new Set((input.value.slice(0,start)+'\n'+input.value.slice(end)).split(/\r?\n/).map(value=>value.trim().toLocaleLowerCase()).filter(Boolean)):new Set();
        return matchingSuggestions(choices.filter(choice => !others.has(choice.toLocaleLowerCase())),normalized).map(value => ({label:value,value}));
      }, (choice, start, end) => {
        input.value = input.value.slice(0,start) + choice.value + input.value.slice(end);
        input.setSelectionRange?.(start + choice.value.length, start + choice.value.length);
        refreshPicker();
      }, tokenBounds);
      const picker = element(input.parentElement, 'select', 'ht-field-input ht-reuse-picker');
      picker.setAttribute('aria-label', `Choose existing ${label}`);
      const refreshPicker=()=>{
        const selected=mode==='lines'?new Set(input.value.split(/\r?\n/).map(value=>value.trim().toLocaleLowerCase())):new Set();
        picker.replaceChildren();
        const placeholder = element(picker, 'option', '', `Choose existing ${label}…`); placeholder.value = '';
        for (const choice of choices) if(!selected.has(choice.toLocaleLowerCase())) { const option = element(picker, 'option', '', choice); option.value = choice; }
        picker.value = '';
      };
      refreshPicker(); input.addEventListener('input',refreshPicker); picker.addEventListener('focus',refreshPicker);
      reuseRefreshers.set(key, () => { refreshPicker(); suggestions.hide(); });
      picker.addEventListener('change', () => {
        if (!picker.value) return;
        if (mode === 'lines') input.value = [...new Set([...input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean), picker.value])].join('\n');
        else if (mode === 'tags') input.value = normalizeTags([...normalizeTags(input.value), picker.value]).join(', ');
        else input.value = picker.value;
        preserveEditorScroll(this.contentEl,()=>{refreshPicker(); suggestions.hide(); input.focus({preventScroll:true});});
      });
    }
    const errorEl = element(form, 'p', 'ht-form-error'); errorEl.setAttribute('role', 'alert');
    const actions = element(form, 'div', 'ht-editor-actions');
    let remove = null;
    if (this.standalone) {
      remove = element(actions, 'button', 'ht-delete-event', 'Delete event'); remove.type = 'button';
      let confirmDelete = false;
      remove.addEventListener('click', async () => {
        if (!confirmDelete) { confirmDelete = true; remove.textContent = 'Confirm delete'; errorEl.textContent = 'Delete this timeline event? This cannot be undone. Cancel to keep it.'; return; }
        if (save.disabled) return;
        save.disabled = true; remove.disabled = true;
        try { await this.plugin.deleteStandalone(this.standalone.id, this.snapshot); this.close(); new Notice('Timeline event deleted.'); }
        catch (error) { errorEl.textContent = error.message; }
        finally { save.disabled = false; remove.disabled = false; }
      });
    }
    const cancel = element(actions, 'button', '', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.close());
    const save = element(actions, 'button', 'mod-cta', editing ? 'Save event' : 'Create event'); save.type = 'submit';
    this.bindSaveShortcut(form, save);
    form.addEventListener('submit', async ev => {
      ev.preventDefault(); if (save.disabled) return;
      errorEl.textContent = '';
      try {
        detectTimeType();
        const data = { 'timeline-important': important.checked };
        for (const [key, input] of Object.entries(inputs)) if (input.value.trim()) data[key] = input.value.trim();
        if (!data['timeline-title']) throw new Error('Enter an event title.');
        if (['undated','factor'].includes(timeType.value)) {
          if(timeType.value==='factor')data['timeline-kind']='factor';
          data['timeline-undated'] = true; delete data['timeline-date']; delete data['timeline-end'];
        } else {
        const parsedStart = parseHistoricalDate(data['timeline-date']);
        if (timeType.value === 'specific') {
          delete data['timeline-end'];
        } else if (!data['timeline-end'] && !['decade', 'century'].includes(parsedStart.precision)) {
          throw new Error('Enter an end date for this period, or enter a decade or century, such as 1920s or 19th century.');
        }
        data['timeline-date'] = parsedStart.canonical;
        if (data['timeline-end']) data['timeline-end'] = parseHistoricalDate(data['timeline-end']).canonical;
        }
        data['timeline-perspectives'] = perspectiveRows.map(row => ({historian:row.historian.value.trim(), interpretation:row.interpretation.value.trim(), source:row.source.value.trim()})).filter(row => row.historian || row.interpretation || row.source);
        data.aliases = normalizeAliases(data.aliases);
        data['timeline-tags'] = normalizeTags(data['timeline-tags']);
        data.timeline = [...new Set((data.timeline || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
        save.disabled = true; save.textContent = 'Saving…';
        const timelineOnly = this.standalone || (!this.file && storage?.value === 'timeline');
        const stored=timelineOnly ? await this.plugin.saveStandalone(data, this.standalone?.id, this.standalone ? this.snapshot : undefined) : await this.plugin.saveEvent(data, this.file, this.snapshot);
        this.close(); new Notice(editing ? 'Timeline event updated.' : timelineOnly ? 'Event added to timeline.' : 'Event and linked note created.');
        if (!editing) {
          if(this.onSaved) await this.onSaved({...eventFromFrontmatter(data,'',data['timeline-title']).event,id:timelineOnly?'timeline:'+stored.id:stored.path});
          else await this.plugin.openTimeline();
        }
      } catch (error) { errorEl.textContent = error.message || String(error); }
      finally { save.disabled = false; save.textContent = editing ? 'Save event' : 'Create event'; }
    });
    inputs['timeline-title'].focus();
  }
}

class TimelineSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const root = this.containerEl; root.replaceChildren();
    element(root, 'h2', '', 'Historical Timeline');
    element(root, 'p', '', 'Events can live in the timeline or in linked Markdown notes. Dates use the proleptic Gregorian calendar; convert other calendars before entering exact dates.');
    const setting = (key, name, description, validate) => {
      let draft = this.plugin.settings[key];
      new Setting(root).setName(name).setDesc(description).addText(input => input.setValue(draft).onChange(value => { draft = value; })).addButton(button => button.setButtonText('Save').onClick(async () => {
        try {
          const value = validate(draft);
          await this.plugin.saveSetting(key, value); new Notice('Timeline setting saved.');
        } catch (error) { new Notice(error.message); }
      }));
    };
    setting('eventFolder', 'New event folder', 'Folder for optional notes; also groups timeline-only events for folder filters. No folder is created for timeline-only events. Blank uses the vault root.', folderPath);
    setting('scanFolder', 'Scan folder', 'Optional: only include events inside this folder and its subfolders. Blank scans the vault.', folderPath);
  }
}

module.exports = HistoricalTimelinePlugin;
