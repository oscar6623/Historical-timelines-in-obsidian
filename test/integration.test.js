'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../src/model');

const FIELDS = ['aliases', 'timeline', 'timeline-title', 'timeline-date', 'timeline-end', 'timeline-category', 'timeline-summary', 'timeline-location', 'timeline-source', 'timeline-tags', 'timeline-important', 'timeline-undated', 'timeline-perspectives', 'timeline-kind'];
const snapshot = fm => JSON.stringify(FIELDS.map(key => [key, fm?.[key] ?? null]));
const event = (title = 'An event', date = '44 BCE') => ({
  timeline: ['History'], 'timeline-title': title, 'timeline-date': date,
});

// A small host contract mock: processFrontMatter commits only after its callback
// succeeds, as Obsidian does. Notes and their metadata remain separately stored.
async function host(settings = {}, options = {}) {
  const files = new Map(), records = new Map(), timers = new Map();
  const layoutCallbacks = [];
  const listeners = { metadata: new Map(), vault: new Map() };
  const calls = { folders: [], created: [], frontmatter: 0, saved: 0, dataSaved: 0, commands: [], views:new Map(), processors:new Map(), renderOptions:[], scopes:[], notices:[] };
  let persisted = structuredClone(settings);
  const storage = { failSave: false };
  let nextTimer = 0;
  class TFile {
    constructor(name) { this.rename(name); }
    rename(name) {
      this.path = name;
      this.name = name.split('/').at(-1);
      this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : '';
      this.basename = this.name.replace(/\.[^.]+$/, '');
    }
  }
  class Plugin {
    constructor(app) { this.app = app; this.cleanup = []; }
    async loadData() { return structuredClone(persisted); }
    async saveData(data) {
      if (storage.failSave) throw new Error('Simulated disk write failure');
      persisted = structuredClone(data); calls.dataSaved += 1;
    }
    registerView(type, factory) { calls.views.set(type,factory); }
    addRibbonIcon() {}
    addCommand(command) { calls.commands.push(command); }
    addSettingTab() {}
    registerMarkdownCodeBlockProcessor(language, processor) { calls.processors.set(language, processor); }
    registerEvent() {}
    register(fn) { this.cleanup.push(fn); }
  }
  const app = {
    vault: {
      getAbstractFileByPath: name => files.get(name) || null,
      getMarkdownFiles: () => [...files.values()].filter(file => file instanceof TFile && file.extension === 'md'),
      async createFolder(name) {
        assert.equal(files.has(name), false, 'folder must not exist');
        files.set(name, { path: name }); calls.folders.push(name);
      },
      async create(name, content) {
        if (files.has(name)) throw new Error('File already exists');
        const file = new TFile(name); files.set(name, file);
        records.set(file, { fm: {}, body: content }); calls.created.push({ name, content });
        return file;
      },
      on(name, callback) { listeners.vault.set(name, callback); return {}; },
    },
    metadataCache: {
      getFileCache: file => ({ frontmatter: records.get(file)?.fm }),
      on(name, callback) { listeners.metadata.set(name, callback); return {}; },
    },
    fileManager: {
      async processFrontMatter(file, callback) {
        calls.frontmatter += 1;
        const record = records.get(file), draft = structuredClone(record.fm);
        callback(draft);
        record.fm = draft; calls.saved += 1;
      },
    },
    workspace: { onLayoutReady(callback) { if (options.deferLayout) layoutCallbacks.push(callback); else callback(); } },
    scope: {},
    keymap: { pushScope(scope){calls.scopes.push(scope);}, popScope(scope){calls.scopes=calls.scopes.filter(item=>item!==scope);} },
  };
  const obsidian = {
    Plugin, TFile, Platform: { isMobile: Boolean(options.mobile) },
    ItemView: class { constructor(leaf){this.leaf=leaf;this.app=leaf.app;this.contentEl={};} async setState(){} }, Modal: class {}, Notice: class { constructor(message){calls.notices.push(message);} },
    Scope: class { constructor(parent){this.parent=parent;this.handlers=[];} register(modifiers,key,callback){this.handlers.push({modifiers,key,callback});} },
    PluginSettingTab: class {}, Setting: class {}, MarkdownRenderChild: class { constructor(el) { this.containerEl = el; } },
    normalizePath: name => name.replace(/\/+/g, '/').replace(/\/$/, ''),
    stringifyYaml: value => JSON.stringify(value, null, 2) + '\n',
    parseYaml: JSON.parse,
  };
  const context = {
    module: { exports: {} },
    crypto: require('node:crypto').webcrypto,
    require(name) {
      if (name === 'obsidian') return obsidian;
      if (name === './model') return model;
      if (name === './suggestions') return require('../src/suggestions');
      if (name === './chart-preferences') return require('../src/chart-preferences');
      if (name === './reading-preferences') return require('../src/reading-preferences');
      if (name === './renderer') return { renderTimeline(container, events, options) {calls.renderOptions.push(options);} };
      throw new Error('Unexpected dependency: ' + name);
    },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), context, { filename: 'src/main.js' });
  const plugin = new context.module.exports(app);
  await plugin.onload();
  const addNote = (name, fm, body = '# Existing note\n\nKeep this text, links, and sources.\n') => {
    const file = new TFile(name); files.set(name, file); records.set(file, { fm: structuredClone(fm), body });
    return file;
  };
  const rename = (file, name) => {
    const previous = file.path; files.delete(previous); file.rename(name); files.set(name, file);
    listeners.vault.get('rename')(file, previous);
  };
  const flush = () => {
    const callbacks = [...timers.values()]; timers.clear();
    for (const callback of callbacks) callback();
  };
  return {
    plugin, app, files, records, timers, listeners, calls, addNote, rename, flush, storage, layoutCallbacks,
    getPersisted: () => structuredClone(persisted),
    setPersisted: value => { persisted = structuredClone(value); },
  };
}

test('desktop views and embeds never access device zoom storage', async () => {
  const h = await host();
  let accesses = 0;
  const doc = { defaultView: { get localStorage() { accesses += 1; throw new Error('Must not access desktop storage'); } } };
  assert.equal(h.plugin.mobileChartPreferences(doc), undefined);
  const view = h.calls.views.values().next().value({ app: h.app });
  view.contentEl.ownerDocument = doc;
  view.render();
  assert.equal(h.calls.renderOptions.at(-1).chartPreferences, undefined);
  assert.equal(h.calls.renderOptions.at(-1).isMobile, false);
  let embed;
  h.calls.processors.get('historical-timeline')('{}', { ownerDocument: doc }, { addChild(child) { embed = child; } });
  embed.render();
  assert.equal(h.calls.renderOptions.at(-1).chartPreferences, undefined);
  assert.equal(h.calls.renderOptions.at(-1).isMobile, false);
  assert.equal(accesses, 0);
  assert.equal(h.calls.dataSaved, 0);
});

test('mobile views and embeds share device zoom without saving it to plugin data or view state', async () => {
  const key = 'historical-timeline:mobile-chart-zoom:v1';
  const data = new Map([['unrelated-device-setting', 'keep']]);
  const writes = [];
  const localStorage = {
    getItem(name) { return data.get(name) ?? null; },
    setItem(name, value) { writes.push({ name, value }); data.set(name, value); },
  };
  let accesses = 0;
  const doc = { defaultView: { get localStorage() { accesses += 1; return localStorage; } } };
  const h = await host({ eventFolder: 'History', custom: { keep: true } }, { mobile: true });
  const note = h.addNote('History/Private.md', event('Private event'));
  h.plugin.reindex();
  const persistedBefore = h.getPersisted();
  const settingsBefore = JSON.stringify(h.plugin.settings);
  const noteBefore = structuredClone(h.records.get(note));
  const view = h.calls.views.values().next().value({ app: h.app });
  view.contentEl.ownerDocument = doc;
  view.state = { mode: 'wall', group: 'History', selected: note.path };
  const viewStateBefore = JSON.stringify(view.getState());
  view.render();
  const preferences = h.calls.renderOptions.at(-1).chartPreferences;
  assert.equal(h.calls.renderOptions.at(-1).isMobile, true);
  assert.equal(typeof preferences.get, 'function');
  assert.equal(typeof preferences.set, 'function');
  assert.equal(preferences, h.plugin.mobileChartPreferences(doc));

  let embed;
  h.calls.processors.get('historical-timeline')('{"mode":"graph","timeline":"History"}',
    { ownerDocument: doc }, { addChild(child) { embed = child; } });
  const embedStateBefore = JSON.stringify(embed.state);
  embed.render();
  assert.equal(h.calls.renderOptions.at(-1).chartPreferences, preferences);
  assert.equal(h.calls.renderOptions.at(-1).isMobile, true);
  preferences.set('wall', 1.75);
  h.calls.renderOptions.at(-1).chartPreferences.set('fishbone', 0.8);
  view.render();
  assert.equal(h.calls.renderOptions.at(-1).chartPreferences, preferences);
  assert.equal(accesses, 1, 'the plugin caches its mobile preferences across renderers');
  assert.deepEqual(JSON.parse(data.get(key)), { wall: 1.75, fishbone: 0.8 });
  assert.equal(writes.length, 2);
  assert.ok(writes.every(write => write.name === key));
  assert.equal(data.get('unrelated-device-setting'), 'keep');
  assert.equal(h.calls.dataSaved, 0);
  assert.equal(h.calls.saved, 0);
  assert.deepEqual(h.getPersisted(), persistedBefore);
  assert.equal(JSON.stringify(h.plugin.settings), settingsBefore);
  assert.deepEqual(h.records.get(note), noteBefore);
  assert.equal(JSON.stringify(view.getState()), viewStateBefore);
  assert.equal(JSON.stringify(embed.state), embedStateBefore);

  const reopened = await host(h.getPersisted(), { mobile: true });
  assert.equal(reopened.plugin.mobileChartPreferences(doc).get('wall'), 1.75);
  assert.equal(reopened.plugin.mobileChartPreferences(doc).get('fishbone'), 0.8);
  const otherDevice = await host(h.getPersisted(), { mobile: true });
  assert.equal(otherDevice.plugin.mobileChartPreferences({ defaultView: { localStorage: {
    getItem() { return null; }, setItem() {},
  } } }).get('wall'), 1, 'synced plugin data carries no device zoom to another device');
});

test('mobile storage getter failures keep a cached memory preference usable by views', async () => {
  const h = await host({}, { mobile: true });
  let accesses = 0;
  const doc = { defaultView: { get localStorage() { accesses += 1; throw new Error('Storage blocked'); } } };
  const preferences = h.plugin.mobileChartPreferences(doc);
  assert.equal(preferences.get('wall'), 1);
  preferences.set('wall', 2.1);
  preferences.set('fishbone', 0.6);
  assert.equal(h.plugin.mobileChartPreferences(doc), preferences);
  const view = h.calls.views.values().next().value({ app: h.app });
  view.contentEl.ownerDocument = doc;
  view.render();
  const rendered = h.calls.renderOptions.at(-1).chartPreferences;
  assert.equal(rendered, preferences);
  assert.equal(rendered.get('wall'), 2.1);
  assert.equal(rendered.get('fishbone'), 0.6);
  assert.equal(accesses, 1);
  assert.equal(h.calls.dataSaved, 0);
  assert.deepEqual(h.getPersisted(), {});
});

test('mobile reading mode defaults on, shares live state across views and embeds, and stays on this device', async () => {
  const data = new Map(), writes = [];
  const doc = { defaultView: { localStorage: {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { writes.push(key); data.set(key, value); },
  } } };
  const h = await host({ custom: { keep: true } }, { mobile: true });
  const note = h.addNote('An event.md', event());
  h.plugin.reindex(); h.flush();
  const originalData = h.getPersisted(), originalNote = structuredClone(h.records.get(note));
  const view = h.calls.views.values().next().value({ app: h.app });
  view.contentEl.ownerDocument = doc;
  view.state = { mode: 'vertical', selected: note.path, group: 'History' };
  const originalState = JSON.stringify(view.getState());
  let embed;
  h.calls.processors.get('historical-timeline')('{}', { ownerDocument: doc }, { addChild(child) { embed = child; } });
  const renders = [];
  h.plugin.subscribe(() => { view.render(); renders.push(h.calls.renderOptions.at(-1).readOnly); });
  h.plugin.subscribe(() => { embed.render(); renders.push(h.calls.renderOptions.at(-1).readOnly); });
  view.render();
  assert.equal(h.calls.renderOptions.at(-1).readOnly, true);
  assert.equal(h.plugin.isReadingMode(doc), true);
  assert.equal(typeof h.calls.renderOptions.at(-1).onReadEvent, 'function');
  assert.equal(typeof h.calls.renderOptions.at(-1).onOpenNote, 'function');

  h.calls.renderOptions.at(-1).onReadOnlyChange(false);
  assert.deepEqual(renders, [false, false], 'all mounted surfaces unlock synchronously');
  assert.equal(h.plugin.isReadingMode(doc), false);
  const reopened = await host(h.getPersisted(), { mobile: true });
  assert.equal(reopened.plugin.isReadingMode(doc), false);
  const otherDevice = await host(h.getPersisted(), { mobile: true });
  assert.equal(otherDevice.plugin.isReadingMode({ defaultView: { localStorage: { getItem() { return null; }, setItem() {} } } }), true);

  h.calls.renderOptions.at(-1).onReadOnlyChange(true);
  assert.deepEqual(renders, [false, false, true, true]);
  assert.equal(writes.length, 2);
  assert.equal(new Set(writes).size, 1, 'only the dedicated reading preference is persisted');
  assert.deepEqual(h.getPersisted(), originalData);
  assert.deepEqual(h.records.get(note), originalNote);
  assert.equal(h.calls.dataSaved, 0);
  assert.equal(h.calls.saved, 0);
  assert.equal(JSON.stringify(view.getState()), originalState);
});

test('desktop never enters the mobile reading mode or reads its device preference', async () => {
  const h = await host();
  const doc = { defaultView: { get localStorage() { throw new Error('Desktop must not access this'); } } };
  assert.equal(h.plugin.isReadingMode(doc), false);
  h.plugin.setReadingMode(true, doc);
  assert.equal(h.plugin.isReadingMode(doc), false);
  const view = h.calls.views.values().next().value({ app: h.app });
  view.contentEl.ownerDocument = doc; view.render();
  assert.equal(Boolean(h.calls.renderOptions.at(-1).readOnly), false);
  assert.equal(h.calls.renderOptions.at(-1).onReadOnlyChange, undefined);
  await h.plugin.saveStandalone(event());
  assert.equal(h.plugin.collect().events.length, 1);
});

test('mobile reading mode remains switchable when device storage is blocked', async () => {
  const h = await host({}, { mobile: true });
  let accesses = 0;
  const doc = { defaultView: { get localStorage() { accesses += 1; throw new Error('Blocked'); } } };
  assert.equal(h.plugin.isReadingMode(doc), true);
  h.plugin.setReadingMode(false, doc);
  assert.equal(h.plugin.isReadingMode(doc), false);
  h.plugin.setReadingMode(true, doc);
  assert.equal(h.plugin.isReadingMode(doc), true);
  assert.equal(accesses, 1);
  assert.equal(h.calls.dataSaved, 0);
});

test('reading mode blocks every content save and delete route before touching files or data', async () => {
  const record = { id: 'one', folder: '', properties: event('Existing') };
  const connection = { id: 'link', from: 'timeline:one', to: 'Two.md', relation: 'led to' };
  const analysis = { id: 'analysis', title: 'Outcome', groups: ['History'], branches: [] };
  const h = await host({ standaloneEvents: [record], connections: [connection], analyses: [analysis] }, { mobile: true });
  const note = h.addNote('Two.md', event('Two'));
  h.plugin.reindex();
  const original = h.getPersisted(), originalNote = structuredClone(h.records.get(note));
  const operations = [
    () => h.plugin.saveStandalone(event('New')),
    () => h.plugin.saveStandalone(event('Changed'), record.id, JSON.stringify(record)),
    () => h.plugin.deleteStandalone(record.id, JSON.stringify(record)),
    () => h.plugin.saveAnalysis({ ...analysis, title: 'Changed' }, analysis),
    () => h.plugin.deleteAnalysis(analysis),
    () => h.plugin.saveConnection({ ...connection, explanation: 'Changed' }, connection),
    () => h.plugin.deleteConnection(connection),
    () => h.plugin.saveEvent(event('New note')),
    () => h.plugin.saveEvent(event('Changed note'), note, snapshot(originalNote.fm)),
  ];
  for (const operation of operations) await assert.rejects(operation(), /reading mode/i);
  assert.deepEqual(h.getPersisted(), original);
  assert.deepEqual(h.records.get(note), originalNote);
  assert.equal(h.calls.dataSaved, 0);
  assert.equal(h.calls.frontmatter, 0);
  assert.equal(h.calls.created.length, 0);
  assert.equal(h.calls.folders.length, 0);
});

test('a queued content write rechecks reading mode after its storage read', async () => {
  const h = await host({}, { mobile: true });
  h.plugin.setReadingMode(false);
  let releaseRead, reading;
  const started = new Promise(resolve => { reading = resolve; });
  const gate = new Promise(resolve => { releaseRead = resolve; });
  h.plugin.loadData = async () => { reading(); await gate; return {}; };
  const save = h.plugin.saveStandalone(event('Must stay unsaved'));
  await started;
  h.plugin.setReadingMode(true);
  const rejected = assert.rejects(save, /reading mode/i);
  releaseRead(); await rejected;
  assert.deepEqual(h.getPersisted(), {});
  assert.equal(h.calls.dataSaved, 0);
});

test('switching to reading mode also blocks a delayed note frontmatter callback', async () => {
  const h = await host({}, { mobile: true });
  h.plugin.setReadingMode(false);
  const note = h.addNote('Existing.md', event('Original'));
  const original = structuredClone(h.records.get(note));
  let releaseWrite, writing;
  const started = new Promise(resolve => { writing = resolve; });
  const gate = new Promise(resolve => { releaseWrite = resolve; });
  const process = h.app.fileManager.processFrontMatter;
  h.app.fileManager.processFrontMatter = async (file, callback) => { writing(); await gate; return process(file, callback); };
  const save = h.plugin.saveEvent(event('Changed'), note, snapshot(original.fm));
  await started;
  h.plugin.setReadingMode(true);
  const rejected = assert.rejects(save, /reading mode/i);
  releaseWrite(); await rejected;
  assert.deepEqual(h.records.get(note), original);
  assert.equal(h.calls.saved, 0);
});

test('reading mode disables editing commands while live Sync updates remain readable', async () => {
  const orphan = { id: 'undated', folder: '', properties: { 'timeline-title': 'Independent factor', 'timeline-kind': 'factor', 'timeline-undated': true } };
  const h = await host({ standaloneEvents: [orphan] }, { mobile: true });
  const command = h.calls.commands.find(item => item.id === 'add-event');
  assert.equal(command.checkCallback(true), false);
  assert.equal(command.checkCallback(false), false);
  assert.equal(h.getPersisted().standaloneEvents.length, 1, 'reading does not trigger orphan cleanup');
  const incoming = { id: 'synced', folder: '', properties: event('Arrived through Sync') };
  h.setPersisted({ standaloneEvents: [orphan, incoming] });
  await h.plugin.onExternalSettingsChange();
  assert.ok(h.plugin.collect().events.some(item => item.title === 'Arrived through Sync'));
  assert.equal(h.plugin.isReadingMode(), true);
  assert.equal(h.calls.dataSaved, 0);
  h.plugin.setReadingMode(false);
  assert.equal(command.checkCallback(true), true);
});

test('explicit note navigation opens native preview in reading mode without changing the note', async () => {
  for (const mobile of [true, false]) {
    const h = await host({}, { mobile });
    const note = h.addNote('Note.md', event());
    const opens = [];
    h.app.workspace.getLeaf = where => ({ openFile: async (...args) => { opens.push({ where, args }); } });
    const original = structuredClone(h.records.get(note));
    h.plugin.openEvent({ path: note.path, storage: 'note' });
    assert.equal(opens[0].where, 'tab');
    assert.equal(opens[0].args[0], note);
    if (mobile) assert.equal(opens[0].args[1]?.state?.mode, 'preview');
    else assert.equal(opens[0].args[1], undefined);
    assert.deepEqual(h.records.get(note), original);
    assert.equal(h.calls.saved, 0);
  }
});

test('new events create nested folders and use unique, safe Unicode filenames', async () => {
  const h = await host({ eventFolder: 'History notes/timeline/Events' });
  const data = event('秦 / Han: founding?');
  const first = await h.plugin.saveEvent(data);
  const second = await h.plugin.saveEvent(data);
  assert.equal(first.path, 'History notes/timeline/Events/秦 - Han- founding-.md');
  assert.equal(second.path, 'History notes/timeline/Events/秦 - Han- founding- 2.md');
  assert.deepEqual(h.calls.folders, ['History notes', 'History notes/timeline', 'History notes/timeline/Events']);
  assert.match(h.calls.created[0].content, /^---\n/);
  assert.match(h.calls.created[0].content, /"timeline-date": "44 BCE"/);
  assert.match(h.calls.created[0].content, /\n# 秦 \/ Han: founding\?\n/);
  assert.equal(h.calls.frontmatter, 0);
});

test('editing changes only timeline fields and preserves body and unrelated properties', async () => {
  const h = await host();
  const original = { ...event(), 'timeline-end': '30 BCE', 'timeline-summary': 'Old summary', tags: ['ancient', 'source'], aliases: ['Rome'], custom: { value: 12 } };
  const file = h.addNote('Notes/Ancient Rome.md', original);
  const originalBody = h.records.get(file).body;
  const updated = { ...event('A revised title', '43 BCE'), 'timeline-source': '[[Primary source]]' };
  const result = await h.plugin.saveEvent(updated, file, snapshot(original));
  assert.equal(result, file);
  assert.equal(file.path, 'Notes/Ancient Rome.md', 'editing must not rename linked notes');
  assert.deepEqual(h.records.get(file).fm, { ...updated, tags: ['ancient', 'source'], aliases: ['Rome'], custom: { value: 12 } });
  assert.equal(h.records.get(file).body, originalBody);
  assert.equal(h.calls.saved, 1);
  assert.equal(h.calls.created.length, 0);
});

test('changes to another timeline field reject stale saves without any committed changes', async () => {
  const h = await host();
  const original = event(), file = h.addNote('Rome.md', original);
  h.records.get(file).fm['timeline-summary'] = 'Edited elsewhere';
  const before = structuredClone(h.records.get(file));
  await assert.rejects(h.plugin.saveEvent(event('My change'), file, snapshot(original)), /changed while this editor was open/);
  assert.deepEqual(h.records.get(file), before);
  assert.equal(h.calls.saved, 0);
});

test('concurrent unrelated metadata edits survive a timeline save', async () => {
  const h = await host();
  const original = event(), file = h.addNote('Rome.md', original);
  h.records.get(file).fm.reviewed = true;
  await h.plugin.saveEvent(event('Changed title'), file, snapshot(original));
  assert.equal(h.records.get(file).fm.reviewed, true);
  assert.equal(h.records.get(file).fm['timeline-title'], 'Changed title');
});

test('an ordinary note can become an event and an editor follows a renamed file', async () => {
  const h = await host();
  const original = { author: 'Researcher', tags: ['history'] };
  const file = h.addNote('Draft.md', original);
  const body = h.records.get(file).body;
  h.rename(file, 'Research/Primary evidence.md');
  await h.plugin.saveEvent(event('Primary evidence'), file, snapshot(original));
  assert.deepEqual(h.records.get(file).fm, { ...original, ...event('Primary evidence') });
  assert.equal(h.records.get(file).body, body);
  assert.equal(h.calls.created.length, 0);
});

test('deleted or replaced notes cannot be overwritten by an open editor', async () => {
  const h = await host();
  const original = event(), oldFile = h.addNote('Rome.md', original);
  const replacement = h.addNote('Rome.md', event('Replacement note'));
  await assert.rejects(h.plugin.saveEvent(event('Stale editor'), oldFile, snapshot(original)), /deleted/);
  assert.equal(h.records.get(replacement).fm['timeline-title'], 'Replacement note');
  h.files.delete('Rome.md');
  await assert.rejects(h.plugin.saveEvent(event('Stale editor'), oldFile, snapshot(original)), /deleted/);
  assert.equal(h.calls.frontmatter, 0);
});

test('invalid historical dates and reverse ranges cannot create folders or write files', async () => {
  const h = await host();
  for (const data of [event('Bad year', '0'), event('Bad day', '2024-02-30'), { ...event('Reverse range', '20 BCE'), 'timeline-end': '44 BCE' }]) {
    await assert.rejects(h.plugin.saveEvent(data), /timeline-(date|end)/);
  }
  assert.deepEqual(h.calls.folders, []);
  assert.deepEqual(h.calls.created, []);
  assert.equal(h.calls.frontmatter, 0);
});

test('new notes use the vault root when selected and reject unsafe folder paths', async () => {
  const h = await host({ eventFolder: '' });
  assert.equal((await h.plugin.saveEvent(event('A root event'))).path, 'A root event.md');
  for (const folder of ['/outside', '../outside', 'Notes/../outside', '.obsidian/plugins', 'Notes/.hidden', 'C:\\outside']) {
    h.plugin.settings.eventFolder = folder;
    await assert.rejects(h.plugin.saveEvent(event()), /vault-relative folder/);
  }
  assert.deepEqual(h.calls.folders, []);
  assert.equal(h.calls.created.length, 1);
});

test('existing notes blocking a folder path are preserved', async () => {
  const h = await host({ eventFolder: 'History.md/Events' });
  const file = h.addNote('History.md', { title: 'History' });
  const before = structuredClone(h.records.get(file));
  await assert.rejects(h.plugin.saveEvent(event()), /note already uses the folder path/);
  assert.deepEqual(h.records.get(file), before);
  assert.equal(h.calls.created.length, 0);
});

test('index respects folder boundaries, filters groups, and removes obsolete metadata', async () => {
  const h = await host({ scanFolder: 'History' });
  const a = h.addNote('History/Rome.md', { ...event('Rome', '44 BCE'), timeline: ['Rome', 'World'], 'timeline-category': 'Politics' });
  h.addNote('History/Modern.md', event('Modern', '2024'));
  h.addNote('History/Nested/Invalid.md', event('Invalid', '0'));
  h.addNote('History/Ordinary.md', { title: 'Ordinary' });
  h.addNote('History-other/Excluded.md', event('Excluded'));
  h.plugin.reindex();
  assert.deepEqual(Array.from(h.plugin.collect().events, value => value.title), ['Rome', 'Modern']);
  assert.deepEqual(Array.from(h.plugin.collect({ timeline: 'World', category: 'Politics' }).events, value => value.path), ['History/Rome.md']);
  assert.deepEqual(Array.from(h.plugin.collect({ folder: 'History/Nested' }).errors, value => value.path), ['History/Nested/Invalid.md']);
  delete h.records.get(a).fm['timeline-date'];
  h.listeners.metadata.get('changed')(a);
  assert.equal(h.plugin.index.has(a.path), false);
});

test('file renames update event links and moves across the scan boundary remove stale entries', async () => {
  const h = await host({ scanFolder: 'History' });
  const file = h.addNote('History/Rome.md', event());
  h.plugin.reindex();
  h.rename(file, 'History/Roman history.md');
  assert.equal(h.plugin.index.has('History/Rome.md'), false);
  assert.equal(h.plugin.collect().events[0].path, 'History/Roman history.md');
  h.rename(file, 'Elsewhere/Roman history.md');
  assert.equal(h.plugin.collect().events.length, 0);
  h.rename(file, 'History/Back.md');
  assert.equal(h.plugin.collect().events[0].path, 'History/Back.md');
  h.rename(file, 'History/Back.txt');
  assert.equal(h.plugin.collect().events.length, 0);
});

test('folder rename notifications rebuild descendant paths without retaining old links', async () => {
  const h = await host({ scanFolder: 'History' });
  const file = h.addNote('History/Old/Rome.md', event());
  h.plugin.reindex();
  h.files.delete(file.path); file.rename('History/New/Rome.md'); h.files.set(file.path, file);
  h.listeners.vault.get('rename')({ path: 'History/New' }, 'History/Old');
  assert.equal(h.plugin.index.has('History/Old/Rome.md'), false);
  assert.equal(h.plugin.collect().events[0].path, 'History/New/Rome.md');
});

test('unrelated note metadata, unchanged event metadata, and unchanged vault resolution do not redraw timelines', async () => {
  const h = await host({ scanFolder: 'History' });
  const ordinary = h.addNote('History/Ordinary.md', { author: 'A' });
  const excluded = h.addNote('Elsewhere/Excluded.md', event('Excluded'));
  const relevant = h.addNote('History/Event.md', event('Relevant'));
  h.plugin.reindex(); h.flush();
  let renders = 0;
  h.plugin.subscribe(() => { renders += 1; });
  const changed = h.listeners.metadata.get('changed');
  h.records.get(ordinary).fm.author = 'B'; changed(ordinary);
  h.records.get(excluded).fm['timeline-title'] = 'Still excluded'; changed(excluded);
  h.records.get(relevant).fm.reviewed = true; changed(relevant);
  changed(relevant);
  h.listeners.metadata.get('resolved')();
  h.listeners.vault.get('delete')(ordinary);
  assert.equal(h.timers.size, 0);
  assert.equal(renders, 0);
  h.records.get(relevant).fm['timeline-title'] = 'Updated title'; changed(relevant);
  assert.equal(h.timers.size, 1);
  h.flush(); assert.equal(renders, 1);
  assert.equal(h.plugin.collect().events[0].title, 'Updated title');
  h.records.get(relevant).fm = { author: 'No longer an event' }; changed(relevant);
  h.flush(); assert.equal(renders, 2);
  assert.equal(h.plugin.collect().events.length, 0);
});

test('delete notifications clear events and subscriptions debounce and release on unload', async () => {
  const h = await host();
  const file = h.addNote('Rome.md', event());
  let renders = 0;
  const unsubscribe = h.plugin.subscribe(() => { renders += 1; });
  h.plugin.reindex(); h.plugin.notify(); h.plugin.notify();
  assert.equal(h.timers.size, 1);
  h.flush(); assert.equal(renders, 1);
  h.files.delete(file.path); h.listeners.vault.get('delete')(file);
  assert.equal(h.plugin.collect().events.length, 0);
  unsubscribe(); h.flush(); assert.equal(renders, 1);
  h.plugin.subscribe(() => { renders += 1; }); h.plugin.notify();
  for (const cleanup of h.plugin.cleanup) cleanup();
  assert.equal(h.timers.size, 0);
  assert.equal(h.plugin.listeners.size, 0);
});

test('external plugin data refreshes all saved values and scan scope without writing or repeating notifications', async () => {
  const h = await host({ scanFolder: 'Desktop' });
  h.addNote('Desktop/Old.md', event('Desktop note'));
  h.addNote('Mobile/New.md', event('Mobile note'));
  h.plugin.reindex(); h.flush();
  let renders = 0;
  h.plugin.subscribe(() => { renders += 1; });
  const remote = {
    eventFolder: 'Mobile/Events', scanFolder: 'Mobile', defaultTimeline: 'World history', ignoreCase: false,
    standaloneEvents: [{ id: 'remote', folder: 'Mobile', properties: event('Synced event') }],
    connections: [{ id: 'link', from: 'Mobile/New.md', to: 'timeline:remote', relation: 'enabled' }],
    analyses: [{ id: 'analysis', title: 'Synced analysis', groups: [], branches: [] }],
    viewOrder: ['graph', 'cards', 'wall', 'vertical'],
    previousEventInput: { timelines: ['World history'], category: 'Politics', tags: ['war'] },
    unknownFutureSetting: { preserved: true }
  };
  h.setPersisted(remote);
  await h.plugin.onExternalSettingsChange();
  assert.deepEqual(Array.from(h.plugin.collect().events, item => item.title).sort(), ['Mobile note', 'Synced event']);
  assert.equal(h.plugin.settings.eventFolder, remote.eventFolder);
  assert.equal(h.plugin.settings.defaultTimeline, remote.defaultTimeline);
  assert.equal(h.plugin.ignoreCase, false);
  for (const key of ['connections', 'analyses', 'viewOrder', 'previousEventInput']) assert.equal(JSON.stringify(h.plugin[key]), JSON.stringify(remote[key]));
  assert.equal(h.calls.dataSaved, 0);
  assert.deepEqual(h.getPersisted(), remote);
  h.flush(); assert.equal(renders, 1);
  await h.plugin.onExternalSettingsChange();
  assert.equal(h.timers.size, 0, 'an unchanged external file does not redraw the timeline');
  assert.equal(h.calls.dataSaved, 0, 'a Sync callback must never write data.json back');
});

test('external refresh is serialized behind local writes and preserves the newest synced data', async () => {
  const h = await host({ unrelated: 'keep' }); h.flush();
  let releaseSave, saving;
  const started = new Promise(resolve => { saving = resolve; });
  const gate = new Promise(resolve => { releaseSave = resolve; });
  const saveData = h.plugin.saveData.bind(h.plugin), loadData = h.plugin.loadData.bind(h.plugin);
  let reads = 0;
  h.plugin.loadData = async () => { reads += 1; return loadData(); };
  h.plugin.saveData = async data => {
    saving(); await gate; await saveData(data);
    h.setPersisted({ ...h.getPersisted(), defaultTimeline: 'Synced after save', ignoreCase: false });
  };
  const local = h.plugin.saveSetting('defaultTimeline', 'Local value');
  await started;
  const external = h.plugin.onExternalSettingsChange();
  await Promise.resolve();
  assert.equal(reads, 1, 'external reload waits until the in-flight local save completes');
  releaseSave();
  await Promise.all([local, external]);
  assert.equal(reads, 2);
  assert.equal(h.plugin.settings.defaultTimeline, 'Synced after save');
  assert.equal(h.plugin.ignoreCase, false);
  assert.equal(h.getPersisted().unrelated, 'keep');
  assert.equal(h.calls.dataSaved, 1);
});

test('external and local scan-folder changes refresh a standalone-only timeline with an unchanged note index', async () => {
  const h = await host({
    scanFolder: 'Desktop',
    standaloneEvents: [
      { id: 'desktop', folder: 'Desktop', properties: event('Desktop event') },
      { id: 'mobile', folder: 'Mobile', properties: event('Mobile event') }
    ]
  });
  h.flush();
  let renders = 0;
  h.plugin.subscribe(() => { renders += 1; });
  assert.equal(h.plugin.index.size, 0);
  assert.deepEqual(Array.from(h.plugin.collect().events, item => item.title), ['Desktop event']);
  h.setPersisted({ ...h.getPersisted(), scanFolder: 'Mobile' });
  await h.plugin.onExternalSettingsChange();
  assert.equal(h.plugin.index.size, 0);
  assert.deepEqual(Array.from(h.plugin.collect().events, item => item.title), ['Mobile event']);
  h.flush(); assert.equal(renders, 1);
  assert.equal(h.calls.dataSaved, 0);
  await h.plugin.saveSetting('scanFolder', 'Desktop');
  assert.equal(h.plugin.index.size, 0);
  assert.deepEqual(Array.from(h.plugin.collect().events, item => item.title), ['Desktop event']);
  h.flush(); assert.equal(renders, 2);
  assert.equal(h.calls.dataSaved, 1);
});

test('synced event edits and deletions keep existing editor snapshots protected', async () => {
  const original = { id: 'synced', folder: '', properties: event('Original') };
  const h = await host({ standaloneEvents: [original] });
  const remote = { ...original, properties: event('Changed on phone') };
  h.setPersisted({ standaloneEvents: [remote], custom: 'keep' });
  await h.plugin.onExternalSettingsChange();
  await assert.rejects(h.plugin.saveStandalone(event('Stale editor'), original.id, JSON.stringify(original)), /changed or was removed/);
  assert.equal(h.plugin.standaloneEvents[0].properties['timeline-title'], 'Changed on phone');
  h.setPersisted({ standaloneEvents: [], custom: 'keep' });
  await h.plugin.onExternalSettingsChange();
  await assert.rejects(h.plugin.deleteStandalone(remote.id, JSON.stringify(remote)), /changed|removed/);
  assert.equal(h.plugin.standaloneEvents.length, 0);
  assert.equal(h.calls.dataSaved, 0);
  assert.deepEqual(h.getPersisted(), { standaloneEvents: [], custom: 'keep' });
});

test('missing, invalid, or unreadable external data retains the last usable state and a later reload recovers', async () => {
  const original = { standaloneEvents: [{ id: 'keep', folder: '', properties: event('Keep me') }] };
  const h = await host(original); h.flush();
  for (const value of [null, 'invalid', { standaloneEvents: {} }, { connections: {} }, { analyses: false }, { viewOrder: 'graph' }]) {
    h.setPersisted(value);
    await h.plugin.onExternalSettingsChange();
    assert.equal(h.plugin.standaloneEvents[0].properties['timeline-title'], 'Keep me');
    assert.equal(h.calls.dataSaved, 0);
    assert.equal(h.timers.size, 0);
  }
  const loadData = h.plugin.loadData.bind(h.plugin);
  h.plugin.loadData = async () => { throw new Error('Temporary read failure'); };
  await h.plugin.onExternalSettingsChange();
  assert.match(h.calls.notices.at(-1), /Temporary read failure/);
  assert.equal(h.plugin.standaloneEvents.length, 1);
  h.plugin.loadData = loadData;
  h.setPersisted({ ...original, defaultTimeline: 'Recovered' });
  await h.plugin.onExternalSettingsChange();
  assert.equal(h.plugin.settings.defaultTimeline, 'Recovered');
  await h.plugin.saveIgnoreCase(false);
  assert.equal(h.plugin.ignoreCase, false, 'a rejected reload does not poison future writes');
});

test('non-object saved data cannot be overwritten by a local mutation', async () => {
  const h = await host();
  for (const value of ['invalid', [], false]) {
    h.setPersisted(value);
    await assert.rejects(h.plugin.saveStandalone(event()), /Saved timeline data is invalid/);
    assert.deepEqual(h.getPersisted(), value);
  }
  assert.equal(h.calls.dataSaved, 0);
});

test('unload blocks deferred layout work, subscriptions, timers, and new writes', async () => {
  const h = await host({}, { deferLayout: true });
  for (const cleanup of h.plugin.cleanup) cleanup();
  for (const callback of h.layoutCallbacks) callback();
  h.plugin.notify(); h.plugin.subscribe(() => { throw new Error('Unloaded listener ran'); });
  await h.plugin.onExternalSettingsChange();
  await assert.rejects(h.plugin.saveIgnoreCase(false), /unloaded/);
  assert.equal(h.plugin.listeners.size, 0);
  assert.equal(h.plugin.refreshTimer, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.dataSaved, 0);
});

test('unload during an external read discards its result and cancels queued writes', async () => {
  const h = await host(); h.flush();
  let releaseRead, reading;
  const started = new Promise(resolve => { reading = resolve; });
  const gate = new Promise(resolve => { releaseRead = resolve; });
  h.plugin.loadData = async () => { reading(); await gate; return { defaultTimeline: 'Arrived after unload' }; };
  const external = h.plugin.onExternalSettingsChange();
  await started;
  const queuedWrite = assert.rejects(h.plugin.saveIgnoreCase(false), /unloaded/);
  for (const cleanup of h.plugin.cleanup) cleanup();
  releaseRead();
  await Promise.all([external, queuedWrite]);
  assert.equal(h.plugin.settings.defaultTimeline, '');
  assert.equal(h.plugin.ignoreCase, true);
  assert.equal(h.calls.dataSaved, 0);
  assert.equal(h.timers.size, 0);
});

test('a write already in progress may finish after unload without rescheduling a render', async () => {
  const h = await host(); h.flush();
  let releaseSave, saving;
  const started = new Promise(resolve => { saving = resolve; });
  const gate = new Promise(resolve => { releaseSave = resolve; });
  const saveData = h.plugin.saveData.bind(h.plugin);
  h.plugin.saveData = async data => { saving(); await gate; return saveData(data); };
  const pending = h.plugin.saveStandalone(event('Already saving'));
  await started;
  for (const cleanup of h.plugin.cleanup) cleanup();
  releaseSave(); await pending;
  assert.equal(h.getPersisted().standaloneEvents.length, 1);
  assert.equal(h.plugin.standaloneEvents.length, 0);
  assert.equal(h.plugin.refreshTimer, null);
  assert.equal(h.timers.size, 0);
});

test('timeline-only events persist and reload without creating notes or folders', async () => {
  const h = await host({ eventFolder: 'History notes/timeline', defaultTimeline: 'China' });
  const properties = { ...event('秦统一', '221 BCE'), 'timeline-summary': 'A standalone event' };
  const record = await h.plugin.saveStandalone(properties);
  assert.equal(typeof record.id, 'string');
  assert.ok(record.id.length > 0);
  assert.equal(record.folder, 'History notes/timeline');
  assert.deepEqual(h.getPersisted().standaloneEvents[0].properties, properties);
  assert.deepEqual(h.calls.created, []);
  assert.deepEqual(h.calls.folders, []);
  assert.equal(h.calls.frontmatter, 0);
  assert.equal(h.files.size, 0);
  const restored = await host(h.getPersisted());
  const collected = restored.plugin.collect().events;
  assert.equal(collected.length, 1);
  assert.equal(collected[0].title, '秦统一');
  assert.equal(collected[0].path, '');
  assert.equal(collected[0].storage, 'timeline');
  assert.equal(collected[0].standaloneId, record.id);
  assert.equal(restored.plugin.settings.defaultTimeline, 'China');
});

test('legacy settings load and remain intact when the first timeline-only event is saved', async () => {
  const h = await host({ eventFolder: '', scanFolder: '', defaultTimeline: 'World history' });
  assert.equal(h.plugin.collect().events.length, 0);
  const record = await h.plugin.saveStandalone(event('Root event'));
  const saved = h.getPersisted();
  assert.equal(record.folder, '');
  assert.equal(saved.eventFolder, '');
  assert.equal(saved.defaultTimeline, 'World history');
  assert.equal(saved.standaloneEvents.length, 1);
  assert.equal(h.plugin.collect().events[0].title, 'Root event');
});

test('timeline-only editing preserves identity and folder without writing a note', async () => {
  const h = await host({ eventFolder: 'History/Rome' });
  const original = await h.plugin.saveStandalone({ ...event(), 'timeline-summary': 'Remove this summary' });
  await h.plugin.saveSetting('eventFolder', 'History/Other');
  const updated = await h.plugin.saveStandalone(event('Revised', '43 BCE'), original.id, JSON.stringify(original));
  assert.equal(updated.id, original.id);
  assert.equal(updated.folder, 'History/Rome');
  assert.equal(h.getPersisted().standaloneEvents.length, 1);
  assert.deepEqual(h.getPersisted().standaloneEvents[0].properties, event('Revised', '43 BCE'));
  assert.equal(h.plugin.collect().events[0].title, 'Revised');
  assert.deepEqual(h.calls.created, []);
});

test('timeline-only stale edits and deletes cannot overwrite newer saved values', async () => {
  const h = await host();
  const original = await h.plugin.saveStandalone(event());
  const staleSnapshot = JSON.stringify(original);
  await h.plugin.saveStandalone(event('Latest revision'), original.id, staleSnapshot);
  const before = h.getPersisted();
  await assert.rejects(h.plugin.saveStandalone(event('Stale revision'), original.id, staleSnapshot), /changed or was removed/);
  await assert.rejects(h.plugin.deleteStandalone(original.id, staleSnapshot), /changed or was removed/);
  assert.deepEqual(h.getPersisted(), before);
  assert.equal(h.plugin.collect().events[0].title, 'Latest revision');
});

test('timeline-only writes check fresh stored data for externally changed and deleted events', async () => {
  const h = await host();
  const original = await h.plugin.saveStandalone(event());
  const changed = h.getPersisted();
  changed.standaloneEvents[0].properties['timeline-title'] = 'Changed on disk';
  h.setPersisted(changed);
  await assert.rejects(h.plugin.saveStandalone(event('Stale form'), original.id, JSON.stringify(original)), /changed or was removed/);
  await assert.rejects(h.plugin.deleteStandalone(original.id, JSON.stringify(original)), /changed or was removed/);
  assert.deepEqual(h.getPersisted(), changed);
  const removed = { ...changed, standaloneEvents: [] };
  h.setPersisted(removed);
  await assert.rejects(h.plugin.saveStandalone(event('Missing event'), original.id, JSON.stringify(original)), /changed or was removed/);
  await assert.rejects(h.plugin.deleteStandalone(original.id, JSON.stringify(original)), /changed or was removed/);
  assert.deepEqual(h.getPersisted(), removed);
});

test('failed timeline-only writes preserve stored and visible events and allow retries', async () => {
  const h = await host();
  const original = await h.plugin.saveStandalone(event());
  const before = h.getPersisted();
  h.storage.failSave = true;
  await assert.rejects(h.plugin.saveStandalone(event('Unsaved new event')), /disk write failure/);
  await assert.rejects(h.plugin.saveStandalone(event('Unsaved edit'), original.id, JSON.stringify(original)), /disk write failure/);
  await assert.rejects(h.plugin.deleteStandalone(original.id, JSON.stringify(original)), /disk write failure/);
  assert.deepEqual(h.getPersisted(), before);
  assert.equal(h.plugin.collect().events.length, 1);
  assert.equal(h.plugin.collect().events[0].title, 'An event');
  h.storage.failSave = false;
  await h.plugin.saveStandalone(event('Retried edit'), original.id, JSON.stringify(original));
  assert.equal(h.plugin.collect().events[0].title, 'Retried edit');
});

test('serialized concurrent event and setting saves retain every successful change', async () => {
  const h = await host();
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => h.plugin.saveStandalone(event('Event ' + i, String(100 + i)))),
    h.plugin.saveSetting('defaultTimeline', 'World'),
    h.plugin.saveSetting('scanFolder', ''),
  ]);
  const saved = h.getPersisted();
  assert.equal(saved.standaloneEvents.length, 8);
  assert.equal(new Set(saved.standaloneEvents.map(record => record.id)).size, 8);
  assert.equal(saved.defaultTimeline, 'World');
  assert.equal(h.plugin.settings.defaultTimeline, 'World');
  assert.deepEqual(saved.standaloneEvents.map(record => record.properties['timeline-title']).sort(), Array.from({ length: 8 }, (_, i) => 'Event ' + i));
  assert.equal(h.plugin.collect().events.length, 8);
});

test('settings updates preserve fresh timeline events and roll back on write failure', async () => {
  const h = await host();
  await h.plugin.saveStandalone(event('Local event'));
  const external = h.getPersisted();
  external.standaloneEvents.push({ id: 'external-event', folder: 'History', properties: event('External event', '2024') });
  h.setPersisted(external);
  await h.plugin.saveSetting('defaultTimeline', 'Updated');
  assert.equal(h.getPersisted().standaloneEvents.length, 2);
  assert.equal(h.plugin.collect().events.length, 2);
  const before = h.getPersisted();
  h.storage.failSave = true;
  await assert.rejects(h.plugin.saveSetting('defaultTimeline', 'Unsaved'), /disk write failure/);
  assert.deepEqual(h.getPersisted(), before);
  assert.equal(h.plugin.settings.defaultTimeline, 'Updated');
});

test('timeline-only events share chronological, timeline, category and folder filtering with notes', async () => {
  const h = await host({ eventFolder: 'History' });
  await h.plugin.saveStandalone({ ...event('Rome', '44 BCE'), timeline: ['Rome', 'World'], 'timeline-category': 'Politics' });
  await h.plugin.saveSetting('eventFolder', 'History/Nested');
  await h.plugin.saveStandalone(event('Nested', '1911'));
  await h.plugin.saveSetting('eventFolder', 'History-other');
  await h.plugin.saveStandalone(event('Excluded', '2024'));
  h.addNote('History/Modern.md', event('Modern note', '2000'));
  h.plugin.reindex();
  assert.deepEqual(Array.from(h.plugin.collect().events, value => value.title), ['Rome', 'Nested', 'Modern note', 'Excluded']);
  assert.deepEqual(Array.from(h.plugin.collect({ folder: 'History' }).events, value => value.title), ['Rome', 'Nested', 'Modern note']);
  assert.deepEqual(Array.from(h.plugin.collect({ folder: 'History/Nested' }).events, value => value.title), ['Nested']);
  assert.deepEqual(Array.from(h.plugin.collect({ timeline: 'World', category: 'Politics' }).events, value => value.title), ['Rome']);
  await h.plugin.saveSetting('scanFolder', 'History');
  h.plugin.reindex();
  assert.deepEqual(Array.from(h.plugin.collect().events, value => value.title), ['Rome', 'Nested', 'Modern note']);
  assert.equal(h.plugin.collect({ folder: 'History-other' }).events.length, 0);
});

test('timeline-only delete removes only its target and persists across reloads', async () => {
  const h = await host();
  const first = await h.plugin.saveStandalone(event('First'));
  const second = await h.plugin.saveStandalone(event('Second'));
  const note = h.addNote('Existing.md', event('Existing note'));
  h.plugin.reindex();
  await h.plugin.deleteStandalone(first.id, JSON.stringify(first));
  assert.equal(h.plugin.getStandalone(first.id), undefined);
  assert.equal(h.plugin.getStandalone(second.id).properties['timeline-title'], 'Second');
  assert.equal(h.files.get(note.path), note);
  assert.equal(h.getPersisted().standaloneEvents.length, 1);
  const restored = await host(h.getPersisted());
  assert.deepEqual(Array.from(restored.plugin.collect().events, value => value.title), ['Second']);
});

test('invalid timeline-only dates and folder paths cause no writes', async () => {
  const h = await host();
  for (const data of [event('Bad year', '0'), event('Bad day', '2024-02-30'), { ...event('Reverse', '20 BCE'), 'timeline-end': '44 BCE' }]) {
    await assert.rejects(h.plugin.saveStandalone(data), /timeline-(date|end)/);
  }
  h.plugin.settings.eventFolder = '../outside';
  await assert.rejects(h.plugin.saveStandalone(event()), /vault-relative folder/);
  assert.equal(h.calls.dataSaved, 0);
  assert.equal(h.plugin.collect().events.length, 0);
  assert.deepEqual(h.calls.created, []);
  assert.deepEqual(h.calls.folders, []);
});

test('opening a timeline-only event routes to its editor without looking for a note', async () => {
  const h = await host();
  await h.plugin.saveStandalone(event('Open me'));
  const target = h.plugin.collect().events[0];
  let edited = null;
  h.plugin.editFromEvent = value => { edited = value; };
  h.app.vault.getAbstractFileByPath = () => { throw new Error('A timeline-only event has no note to open'); };
  h.plugin.openEvent(target);
  assert.equal(edited, target);
});

test('event tags survive standalone reloads and note edits preserve native Obsidian tags', async () => {
 const h=await host();const data={...event('Tagged'),'timeline-tags':['war','外交']};
 await h.plugin.saveStandalone(data);
 const restored=await host(h.getPersisted());
 assert.deepEqual(Array.from(restored.plugin.collect({tag:'#war'}).events[0].tags),['war','外交']);
 const original={...data,tags:['existing-native-tag']};const note=h.addNote('Tagged.md',original);
 await h.plugin.saveEvent({...data,'timeline-tags':['culture']},note,snapshot(original));
 assert.deepEqual(h.records.get(note).fm.tags,['existing-native-tag']);
 assert.deepEqual(h.records.get(note).fm['timeline-tags'],['culture']);
});

test('importance persists in standalone events and can be cleared', async()=>{
 const h=await host();const record=await h.plugin.saveStandalone({...event('Important'),'timeline-important':true});
 assert.equal(h.plugin.collect().events[0].important,true);
 await h.plugin.saveStandalone({...event('Important'),'timeline-important':false},record.id,JSON.stringify(record));
 assert.equal(h.plugin.collect().events[0].important,false);
});

test('connections persist, reject duplicates and stale edits, and follow note renames',async()=>{
 const h=await host();const a=h.addNote('A.md',event('A')),b=h.addNote('B.md',event('B'));
 h.plugin.reindex();
 const link=await h.plugin.saveConnection({from:a.path,to:b.path,relation:'prompted',source:'Book',explanation:'Reason',disputed:true});
 assert.equal(h.plugin.connections.length,1);
 await assert.rejects(h.plugin.saveConnection({from:a.path,to:a.path,relation:'x'}),/different/);
 await assert.rejects(h.plugin.saveConnection(link),/already exists/);
 const updated=await h.plugin.saveConnection({...link,explanation:'Updated'},link);
 await assert.rejects(h.plugin.saveConnection(link,link),/changed/);
 h.rename(a,'Renamed.md');await h.plugin.writeQueue;
 assert.equal(h.plugin.connections[0].from,'Renamed.md');
 await assert.rejects(h.plugin.deleteConnection(updated),/changed/);
 await h.plugin.deleteConnection(h.plugin.connections[0]);assert.equal(h.plugin.connections.length,0);
});

test('connections between standalone events survive event edits and failed writes',async()=>{
 const h=await host();const a=await h.plugin.saveStandalone(event('A')),b=await h.plugin.saveStandalone(event('B'));
 const link=await h.plugin.saveConnection({from:'timeline:'+a.id,to:'timeline:'+b.id,relation:'enabled'});
 await h.plugin.saveStandalone(event('Renamed A'),a.id,JSON.stringify(a));
 assert.equal(h.plugin.connections[0].from,'timeline:'+a.id);
 h.storage.failSave=true;
 await assert.rejects(h.plugin.deleteConnection(link),/disk/);
 assert.equal(h.plugin.connections.length,1);
});

test('view order persists without replacing events or connections',async()=>{
 const h=await host();await h.plugin.saveStandalone(event());
 await h.plugin.saveViewOrder(['vertical','graph','cards','wall']);
 assert.deepEqual(Array.from(h.plugin.viewOrder),['vertical','graph','cards','wall']);
 assert.equal(h.plugin.standaloneEvents.length,1);
 await assert.rejects(h.plugin.saveViewOrder(['cards','cards','wall','graph']),/Invalid/);
});

test('quick-created undated connection endpoints commit atomically and survive reload',async()=>{
 const h=await host();const a=await h.plugin.saveStandalone(event('Known'));
 const link=await h.plugin.saveConnection({from:'timeline:'+a.id,toNew:{title:'Unknown cause',date:'',groups:['History']},relation:'enabled'});
 const added=h.plugin.collect().events.find(item=>item.id===link.to);assert.equal(added.start,null);
 const fresh=await host(h.getPersisted());assert.equal(fresh.plugin.collect().events.length,2);assert.equal(fresh.plugin.connections.length,1);
 h.storage.failSave=true;
 await assert.rejects(h.plugin.saveConnection({from:link.from,toNew:{title:'Should not exist'},relation:'prompted'}),/disk/);
 assert.equal(h.plugin.collect().events.length,2);
});
test('quick create rejects case-insensitive duplicate names and invalid dates without leaving records',async()=>{
 const h=await host();const a=await h.plugin.saveStandalone(event('Known'));
 await assert.rejects(h.plugin.saveConnection({from:'timeline:'+a.id,toNew:{title:'KNOWN'},relation:'enabled'}),/already exists/);
 await assert.rejects(h.plugin.saveConnection({from:'timeline:'+a.id,toNew:{title:'New',date:'wrong'},relation:'enabled'}));
 assert.equal(h.plugin.standaloneEvents.length,1);
});
test('undated events can later receive dates and perspectives survive save',async()=>{
 const h=await host();const data={'timeline-title':'Undated','timeline-undated':true,'timeline-perspectives':[{historian:'A',interpretation:'View',source:'Book'}]};
 const record=await h.plugin.saveStandalone(data);assert.equal(h.plugin.collect().events[0].start,null);
 await h.plugin.saveStandalone({...data,'timeline-undated':false,'timeline-date':'1900'},record.id,JSON.stringify(record));
 assert.equal(h.plugin.collect().events[0].start.year,1900);assert.equal(h.plugin.collect().events[0].perspectives.length,1);
 await h.plugin.saveIgnoreCase(false);assert.equal((await host(h.getPersisted())).plugin.ignoreCase,false);
});

test('timeline search is a configurable command without an assigned hotkey',async()=>{
 const h=await host();const command=h.calls.commands.find(command=>command.id==='search-timeline-events');
 assert.ok(command);assert.equal(command.hotkeys,undefined);
 h.app.workspace.getActiveViewOfType=()=>null;assert.equal(command.checkCallback(true),false);
 let focused=0;h.app.workspace.getActiveViewOfType=()=>({focusSearch(){focused++;}});
 assert.equal(command.checkCallback(true),true);assert.equal(focused,0);assert.equal(command.checkCallback(false),true);assert.equal(focused,1);
});

test('saved analyses retain small-event connections and reject stale edits and failed writes', async()=>{
 const links=[{id:'l',from:'A',to:'B',relation:'led to'}];const h=await host({connections:links,otherSetting:'keep'});
 const draft={title:'Why expansion?',groups:['Japan'],headEventId:'',branches:[{title:'Economic pressures',factors:[{title:'Self-sufficiency',role:'Background condition',source:'Book',perspectives:'Historian A: ...\n\nHistorian B: ...',disputed:true}]}]};
 const first=await h.plugin.saveAnalysis(draft);assert.equal(h.getPersisted().analyses.length,1);assert.deepEqual(h.getPersisted().connections,links);assert.equal(h.getPersisted().otherSetting,'keep');assert.equal(h.getPersisted().standaloneEvents.length,0);
 const second=await h.plugin.saveAnalysis({...draft,title:'Expansion into Manchuria'},first);await assert.rejects(h.plugin.saveAnalysis(draft,first),/changed/);await assert.rejects(h.plugin.deleteAnalysis(first),/changed/);
 h.storage.failSave=true;await assert.rejects(h.plugin.saveAnalysis({...draft,title:'Unsaved'},second),/failure/);assert.equal(h.plugin.analyses[0].title,second.title);
 h.storage.failSave=false;await h.plugin.deleteAnalysis(second);assert.equal(h.getPersisted().analyses.length,0);assert.deepEqual(h.getPersisted().connections,links);
});
test('analysis event references follow note renames, preserving explanation and head text',async()=>{
 const h=await host();const note=h.addNote('A.md',event('A','1900'));h.plugin.reindex();
 await h.plugin.saveAnalysis({title:'Larger outcome',groups:[],headEventId:'A.md',branches:[{title:'Branch',factors:[{title:'Argument',eventId:'A.md',explanation:'Evidence'}]}]});
 h.rename(note,'Renamed.md');await h.plugin.writeQueue;
 const saved=h.getPersisted().analyses[0];assert.equal(saved.headEventId,'Renamed.md');assert.equal(saved.branches[0].factors[0].eventId,'Renamed.md');assert.equal(saved.title,'Larger outcome');
});
test('invalid analysis saves cannot overwrite stored data',async()=>{
 const h=await host();await assert.rejects(h.plugin.saveAnalysis({title:'',groups:[],branches:[]}),/Name the outcome/);
 await assert.rejects(h.plugin.saveAnalysis({title:'Question',groups:[],branches:[{title:'',factors:[]}]}),/branch/);
 await assert.rejects(h.plugin.saveAnalysis({title:'Question',groups:[],branches:[{title:'Economics',factors:[{}]}]}),/Name each factor/);
 assert.equal(h.calls.dataSaved,0);
});

test('creating an abstract factor and connection is atomic and persists without dates or notes',async()=>{
 const h=await host();const source=await h.plugin.saveStandalone(event('Treaty','1905'));
 const from='timeline:'+source.id;const draft={from,toNew:{title:'Nationalism becomes dominant',kind:'factor',groups:['Japan']},relation:'contributed to'};
 h.storage.failSave=true;await assert.rejects(h.plugin.saveConnection(draft),/failure/);assert.equal(h.getPersisted().standaloneEvents.length,1);assert.equal((h.getPersisted().connections||[]).length,0);
 h.storage.failSave=false;const link=await h.plugin.saveConnection(draft);const factor=h.plugin.collect().events.find(item=>item.id===link.to);assert.equal(factor.kind,'factor');assert.equal(factor.start,null);assert.deepEqual([...factor.groups],['Japan']);assert.equal(h.calls.created.length,0);
 const record=h.getPersisted().standaloneEvents.find(item=>item.id===factor.standaloneId);assert.equal(record.properties['timeline-kind'],'factor');assert.equal(record.properties['timeline-date'],undefined);
});

test('automatic cleanup archives only unreferenced undated records, preserving every saved analysis reference',async()=>{
 const h=await host();
 const dated=await h.plugin.saveStandalone(event('Independent dated'));
 const source='timeline:'+dated.id;
 const first=await h.plugin.saveConnection({from:source,toNew:{title:'Unused factor',kind:'factor'},relation:'led to'});
 const second=await h.plugin.saveConnection({from:source,toNew:{title:'Referenced factor',kind:'factor'},relation:'led to'});
 const kept=second.to;
 await h.plugin.saveAnalysis({title:'Keep evidence',groups:[],headEventId:kept,branches:[{title:'Branch',eventId:kept,factors:[{title:'Evidence',eventId:kept}]}]});
 await h.plugin.deleteConnection(second);assert.ok(h.plugin.collect().events.some(e=>e.id===kept));
 await h.plugin.deleteConnection(first);
 assert.equal(h.plugin.collect().events.some(e=>e.id===first.to),false);
 assert.ok(h.plugin.collect().events.some(e=>e.id===source));
 assert.equal(h.getPersisted().unusedEventArchive[0].record.properties['timeline-title'],'Unused factor');
 const analysis=h.plugin.analyses[0];await h.plugin.deleteAnalysis(analysis);
 assert.equal(h.plugin.collect().events.some(e=>e.id===kept),false);
 assert.equal(h.getPersisted().unusedEventArchive.length,2);
});

test('cleanup and connection deletion roll back together on disk failure',async()=>{
 const h=await host(),source=await h.plugin.saveStandalone(event('Source'));
 const link=await h.plugin.saveConnection({from:'timeline:'+source.id,toNew:{title:'Undated endpoint'},relation:'enabled'});
 h.storage.failSave=true;await assert.rejects(h.plugin.deleteConnection(link),/failure/);
 assert.ok(h.plugin.collect().events.some(e=>e.id===link.to));assert.equal(h.plugin.connections.length,1);assert.equal(h.getPersisted().unusedEventArchive,undefined);
});

test('previous event inputs persist atomically across reloads and ignore edits and failed creates',async()=>{
 const h=await host();const properties={...event('First','1900'),timeline:['Japan','World History'],'timeline-category':'Politics','timeline-tags':['#War','外交']};
 const record=await h.plugin.saveStandalone(properties);
 const expected={timelines:['Japan','World History'],category:'Politics',tags:['war','外交']};
 assert.deepEqual(h.getPersisted().previousEventInput,expected);
 const reloaded=await host(h.getPersisted());assert.equal(JSON.stringify(reloaded.plugin.previousEventInput),JSON.stringify(expected));
 await h.plugin.saveStandalone({...properties,'timeline-category':'Economics'},record.id,JSON.stringify(record));
 assert.deepEqual(h.getPersisted().previousEventInput,expected);
 h.storage.failSave=true;await assert.rejects(h.plugin.saveStandalone({...event('Failed','1901'),timeline:['Russia']}));
 assert.equal(JSON.stringify(h.plugin.previousEventInput),JSON.stringify(expected));assert.deepEqual(h.getPersisted().previousEventInput,expected);
 h.storage.failSave=false;await h.plugin.saveStandalone({...event('Empty','1902'),timeline:[]});
 assert.deepEqual(h.getPersisted().previousEventInput,{timelines:[],category:'',tags:[]});
});

test('note creation remembers previous inputs but preference failure never turns a saved note into a failed create',async()=>{
 const h=await host({previousEventInput:{timelines:['Old'],category:'Old',tags:[]}});
 const properties={...event('Note','1900'),timeline:['Japan'],'timeline-category':'Politics','timeline-tags':['war']};
 await h.plugin.saveEvent(properties);
 assert.deepEqual(h.getPersisted().previousEventInput,{timelines:['Japan'],category:'Politics',tags:['war']});
 h.storage.failSave=true;const file=await h.plugin.saveEvent({...properties,'timeline-title':'Another',timeline:['Russia']});
 assert.ok(h.files.has(file.path));assert.equal(h.calls.created.length,2);
 assert.equal(JSON.stringify(h.plugin.previousEventInput.timelines),JSON.stringify(['Russia']));
 assert.deepEqual(h.getPersisted().previousEventInput.timelines,['Japan']);
 const previous=JSON.stringify(h.plugin.previousEventInput);
 h.app.vault.create=async()=>{throw new Error('Note creation failed');};
 await assert.rejects(h.plugin.saveEvent({...properties,'timeline-title':'Failed'}),/Note creation failed/);
 assert.equal(JSON.stringify(h.plugin.previousEventInput),previous);
});

test('search Escape scope activates only on field focus and is released on blur or disposal',async()=>{
 const h=await host();const view=h.calls.views.values().next().value({app:h.app});view.render();
 const bind=h.calls.renderOptions.at(-1).bindSearchEscape;
 const input={ownerDocument:{activeElement:null},events:{},addEventListener(type,handler){this.events[type]=handler;},removeEventListener(type,handler){if(this.events[type]===handler)delete this.events[type];}};
 let consumed=false;const release=bind(input,()=>consumed);
 assert.equal(h.calls.scopes.length,0);input.events.focus();input.events.focus();assert.equal(h.calls.scopes.length,1);
 const scope=h.calls.scopes[0];assert.equal(scope.parent,h.app.scope);assert.equal(scope.handlers[0].key,'Escape');assert.equal(scope.handlers[0].modifiers.length,0);
 assert.equal(scope.handlers[0].callback({}),undefined);consumed=true;assert.equal(scope.handlers[0].callback({}),false);
 input.events.blur();assert.equal(h.calls.scopes.length,0);input.events.focus();release();assert.equal(h.calls.scopes.length,0);assert.deepEqual(input.events,{});release();assert.equal(h.calls.scopes.length,0);
});

test('aliases persist through standalone reloads and note edits, can be cleared, and protect against stale saves',async()=>{
 const h=await host();const properties={...event('Incident','1937'),aliases:['MPBI','七七事变']};
 const record=await h.plugin.saveStandalone(properties);
 const restored=await host(h.getPersisted());assert.deepEqual(Array.from(restored.plugin.collect().events[0].aliases),properties.aliases);
 const file=h.addNote('Incident.md',properties);
 await h.plugin.saveEvent({...properties,aliases:['Marco Polo']},file,snapshot(properties));
 assert.deepEqual(h.records.get(file).fm.aliases,['Marco Polo']);
 await assert.rejects(h.plugin.saveEvent(properties,file,snapshot(properties)),/changed while/);
 const updated=structuredClone(h.records.get(file).fm);
 await h.plugin.saveEvent({...updated,aliases:[]},file,snapshot(updated));assert.deepEqual(h.records.get(file).fm.aliases,[]);
 await h.plugin.saveStandalone({...properties,aliases:[]},record.id,JSON.stringify(record));
 assert.equal(h.plugin.collect().events.find(e=>e.id==='timeline:'+record.id).aliases.length,0);
});

test('connections require an explicitly entered relationship and never write a default',async()=>{
 const h=await host();const a=await h.plugin.saveStandalone(event('A')),b=await h.plugin.saveStandalone(event('B'));
 await assert.rejects(h.plugin.saveConnection({from:'timeline:'+a.id,to:'timeline:'+b.id,relation:''}),/Enter a relationship/);
 assert.equal(h.plugin.connections.length,0);
});

test('timeline view restores multiple filters, migrates legacy state, and keeps array snapshots independent',async()=>{
 const h=await host();h.app.workspace.requestSaveLayout=()=>{};
 const view=h.calls.views.values().next().value({app:h.app});
 await view.setState({mode:'cards',group:' Japan '},{history:false});
 assert.deepEqual(Array.from(view.state.groups),['Japan']);assert.equal(view.state.group,'Japan');
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialGroups),['Japan']);
 const restored={mode:'cards',group:'Legacy',groups:[' Japan ','World History','Japan','',null,42]};
 await view.setState(restored,{history:false});restored.groups.push('China');
 assert.deepEqual(Array.from(view.state.groups),['Japan','World History']);assert.equal(view.state.group,'');
 const snapshot=view.getState();snapshot.groups.push('Russia');
 const passed=h.calls.renderOptions.at(-1).initialGroups;passed.push('Korea');
 assert.deepEqual(Array.from(view.state.groups),['Japan','World History'],'history and renderer options cannot mutate the saved selection');
 const next={...view.getState(),groups:['China','World History']};
 await h.calls.renderOptions.at(-1).onStateChange(next);next.groups.length=0;
 assert.deepEqual(Array.from(view.state.groups),['China','World History']);
 await view.setState({group:'Japan',groups:[]},{history:false});
 assert.deepEqual(Array.from(view.state.groups),[]);assert.equal(view.state.group,'');
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialGroups),[]);
});

test('tag exclusions normalize and survive layout snapshots without shared arrays or changing timeline selections',async()=>{
 const h=await host();h.app.workspace.requestSaveLayout=()=>{};
 const view=h.calls.views.values().next().value({app:h.app});
 await view.setState({mode:'cards',group:'Japan'},{history:false});
 assert.deepEqual(Array.from(view.state.excludedTags),[]);
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialExcludedTags),[]);
 const restored={mode:'cards',groups:['Japan','World History'],excludedTags:[' #Paper-1 ','Essay','paper-1','',null,42]};
 await view.setState(restored,{history:false});restored.excludedTags.push('paper-2');
 assert.deepEqual(Array.from(view.state.groups),['Japan','World History']);assert.equal(view.state.group,'');
 assert.deepEqual(Array.from(view.state.excludedTags),['paper-1','essay']);
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialGroups),['Japan','World History']);
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialExcludedTags),['paper-1','essay']);
 const snapshot=view.getState();snapshot.excludedTags.push('optional');
 h.calls.renderOptions.at(-1).initialExcludedTags.push('practice');
 assert.deepEqual(Array.from(view.state.excludedTags),['paper-1','essay']);
 const reopened=h.calls.views.values().next().value({app:h.app});
 await reopened.setState(JSON.parse(JSON.stringify(view.getState())),{history:false});
 assert.deepEqual(Array.from(reopened.state.groups),['Japan','World History']);
 assert.deepEqual(Array.from(reopened.state.excludedTags),['paper-1','essay']);
 const next={groups:['China','World History'],excludedTags:['paper-1']};
 await view.acceptState(next);next.excludedTags.push('paper-2');next.groups.push('Russia');
 assert.deepEqual(Array.from(view.state.groups),['China','World History']);assert.equal(view.state.group,'');
 assert.deepEqual(Array.from(view.state.excludedTags),['paper-1']);
 await view.setState({group:'Japan',excludedTags:['Japan']},{history:false});
 assert.deepEqual(Array.from(view.state.groups),['Japan']);assert.equal(view.state.group,'Japan');
 assert.deepEqual(Array.from(view.state.excludedTags),['japan']);
 await view.setState({group:'Japan',excludedTags:'paper-1'},{history:false});
 assert.deepEqual(Array.from(view.state.excludedTags),[]);assert.deepEqual(Array.from(view.state.groups),['Japan']);
});

test('embedded timelines retain multiple filters independently from renderer callbacks',async()=>{
 const h=await host();let embed;
 h.calls.processors.get('historical-timeline')('{}',{}, {addChild(child){embed=child;}});
 embed.render();
 const state={mode:'cards',group:'Legacy',groups:['Japan','World History']};
 h.calls.renderOptions.at(-1).onStateChange(state);state.groups.push('China');embed.render();
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialGroups),['Japan','World History']);
 assert.equal(embed.state.group,'');
 h.calls.renderOptions.at(-1).initialGroups.push('Russia');
 assert.deepEqual(Array.from(embed.state.groups),['Japan','World History']);
 h.calls.renderOptions.at(-1).onStateChange({group:'Japan',groups:[]});embed.render();
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialGroups),[]);
 assert.equal(embed.state.group,'');
});

test('embedded tag exclusions retain isolated state across renders and leave timeline selections intact',async()=>{
 const h=await host();let embed;
 h.calls.processors.get('historical-timeline')('{}',{}, {addChild(child){embed=child;}});
 embed.render();assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialExcludedTags),[]);
 const state={mode:'cards',groups:['Japan','World History'],excludedTags:['paper-1','essay']};
 h.calls.renderOptions.at(-1).onStateChange(state);state.excludedTags.push('paper-2');embed.render();
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialGroups),['Japan','World History']);assert.equal(embed.state.group,'');
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialExcludedTags),['paper-1','essay']);
 h.calls.renderOptions.at(-1).initialExcludedTags.push('practice');
 assert.deepEqual(Array.from(embed.state.excludedTags),['paper-1','essay']);
 h.calls.renderOptions.at(-1).onStateChange({groups:['Japan'],excludedTags:[]});embed.render();
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialExcludedTags),[]);
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialGroups),['Japan']);
});

test('creating events inherits every selected timeline and reveals saves outside the filter',async()=>{
 const h=await host(),view=h.calls.views.values().next().value({app:h.app});let creation;
 h.plugin.editEvent=(file,groups,onSaved)=>{creation={file,groups,onSaved};};
 view.state={mode:'vertical',groups:['Japan','World History'],group:''};view.render();
 h.calls.renderOptions.at(-1).onCreate();
 assert.equal(creation.file,undefined);assert.deepEqual(Array.from(creation.groups),['Japan','World History']);
 creation.groups.push('China');assert.deepEqual(Array.from(view.state.groups),['Japan','World History']);
 creation.onSaved({id:'overlapping',start:{year:1900},groups:['World History']});
 assert.deepEqual(Array.from(view.state.groups),['Japan','World History']);assert.equal(view.state.selected,'overlapping');
 h.calls.renderOptions.at(-1).onCreate();creation.onSaved({id:'outside',start:{year:1901},groups:['Russia']});
 assert.deepEqual(Array.from(view.state.groups),[]);assert.equal(view.state.group,'');assert.equal(view.state.selected,'outside');
 view.state={mode:'cards',group:'Japan'};view.render();
 h.calls.renderOptions.at(-1).onCreate();assert.deepEqual(Array.from(creation.groups),['Japan']);
 creation.onSaved({id:'same',start:{year:1902},groups:['Japan']});
 assert.deepEqual(Array.from(view.state.groups),['Japan']);assert.equal(view.state.group,'Japan');
});

test('saving a new dated event removes only matching tag exclusions when revealing it',async()=>{
 for(const mode of ['cards','vertical']){
  const h=await host(),view=h.calls.views.values().next().value({app:h.app});let creation;
  h.plugin.editEvent=(file,groups,onSaved)=>{creation={groups,onSaved};};
  view.state={mode,groups:['Japan','World History'],excludedTags:['paper-1','essay']};view.render();
  h.calls.renderOptions.at(-1).onCreate();
  assert.deepEqual(Array.from(creation.groups),['Japan','World History'],'tag exclusions do not change new event timeline defaults');
  creation.onSaved({id:'overlapping',start:{year:1900},groups:['World History','Russia'],tags:['paper-1','paper-2']});
  assert.deepEqual(Array.from(view.state.groups),['Japan','World History']);
  assert.deepEqual(Array.from(view.state.excludedTags),['essay']);assert.equal(view.state.selected,'overlapping');
  assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialExcludedTags),['essay']);
  h.calls.renderOptions.at(-1).onCreate();creation.onSaved({id:'outside',start:{year:1901},groups:['Russia'],tags:['paper-2']});
  assert.deepEqual(Array.from(view.state.groups),[]);assert.equal(view.state.group,'');
  assert.deepEqual(Array.from(view.state.excludedTags),['essay']);assert.equal(view.state.selected,'outside');
  h.calls.renderOptions.at(-1).onCreate();assert.deepEqual(Array.from(creation.groups),[]);
  creation.onSaved({id:'undated',start:null,groups:['China'],tags:['essay']});
  assert.deepEqual(Array.from(view.state.excludedTags),['essay'],'saving without dated-event reveal preserves tag exclusions');
 }
});

test('plugin navigation uses leaf history, restores events and filters, and avoids rebuilding on ordinary selection',async()=>{
 const h=await host();h.app.workspace.requestSaveLayout=()=>{};
 const record=await h.plugin.saveStandalone(event('Event B','1900'));
 const leaf={app:h.app},view=h.calls.views.values().next().value(leaf);leaf.view=view;
 const back=[],forward=[];
 leaf.setViewState=async target=>{
  assert.equal(target.type,'historical-timeline-view');
  const previous=view.getState(),result={history:false};await view.setState(target.state,result);
  if(result.history){back.push(previous);forward.length=0;}
 };
 const a={mode:'vertical',selected:'event-a',query:'original',searchScope:'title',collapsed:true,groups:['Japan','World History'],excludedTags:['paper-1','essay']};
 view.state={...a};view.render();const initialRenders=h.calls.renderOptions.length;
 const b={...a,selected:'timeline:'+record.id,query:'',groups:['History'],excludedTags:['paper-2']};
 await h.calls.renderOptions.at(-1).onStateChange(b,{navigation:true});
 assert.equal(view.navigation,true);assert.equal(back.length,1);assert.equal(back[0].selected,'event-a');
 a.excludedTags.push('practice');b.excludedTags.push('optional');
 assert.deepEqual(Array.from(back[0].excludedTags),['paper-1','essay']);
 assert.deepEqual(Array.from(view.state.excludedTags),['paper-2']);
 assert.equal(h.calls.renderOptions.length,initialRenders,'selecting does not replace the mounted list');
 await view.acceptState({...view.getState(),query:'typing'});await view.acceptState({...view.getState(),collapsed:false});
 assert.equal(back.length,1,'typing and panel changes do not create entries');
 await view.acceptState({...view.state},{navigation:true});assert.equal(back.length,1,'same destination does not create entries');
 await view.acceptState({...view.state,mode:'wall'},{navigation:true});assert.equal(back.length,2);
 const go=async(from,to)=>{const state=from.pop();to.push(view.getState());await view.setState(state,{history:false});};
 await go(back,forward);assert.equal(view.state.mode,'vertical');assert.equal(view.state.selected,b.selected);
 assert.deepEqual(Array.from(view.state.groups),['History']);assert.equal(view.state.group,'History');
 assert.deepEqual(Array.from(view.state.excludedTags),['paper-2']);
 assert.deepEqual(Array.from(h.calls.renderOptions.at(-1).initialExcludedTags),['paper-2']);
 assert.equal(h.calls.renderOptions.at(-1).revealEvent,b.selected);
 await go(back,forward);assert.equal(view.state.selected,a.selected);assert.equal(view.state.query,'original');assert.equal(view.state.collapsed,true);
 assert.deepEqual(Array.from(view.state.groups),['Japan','World History']);assert.equal(view.state.group,'');
 assert.deepEqual(Array.from(view.state.excludedTags),['paper-1','essay']);
 await go(forward,back);assert.equal(view.state.selected,b.selected);
 assert.deepEqual(Array.from(view.state.groups),['History']);
 assert.deepEqual(Array.from(view.state.excludedTags),['paper-2']);
 await view.acceptState({...view.state,mode:'graph',graphMode:'events',graphSelected:b.selected},{navigation:true});
 assert.equal(forward.length,0,'new navigation clears the forward branch');
 await go(back,forward);assert.equal(view.state.mode,'vertical');
});
