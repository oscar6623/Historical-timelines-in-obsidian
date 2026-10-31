'use strict';

const { dateUpperBound, normalizeTags } = require('./model');
const { searchText } = require('./suggestions');
const { mountFishbones, buildAnalysisFishbone, buildTimelineFishbone } = require('./graph');
const { mountChartZoom } = require('./chart-zoom');

/** Render a self-contained timeline using standard DOM APIs. */
function renderTimeline(container, inputEvents, options = {}) {
  const doc = container.ownerDocument;
  let readOnly = Boolean(options.readOnly), disposed = false, closeReadPreview;
  // Keep all mutation callbacks guarded, including detached controls retained by
  // a pending gesture while the host replaces this renderer.
  options = { ...options };
  for (const key of ['onCreate', 'onEdit', 'onConnect', 'onAnalysisEdit']) {
    const callback = options[key];
    if (callback) options[key] = (...args) => { if (!readOnly && !disposed) return callback(...args); };
  }
  // Opt in through Obsidian's mobile platform flag. Desktop rendering and
  // keyboard/mouse interactions retain their existing behavior.
  const zoomOptions = kind => options.chartPreferences && doc.defaultView?.PointerEvent ? {
    initialScale: options.chartPreferences.get(kind),
    onScaleChange: scale => options.chartPreferences.set(kind, scale)
  } : undefined;
  const scrollSelectors=['.ht-wall-scroll','.ht-vertical-list','.ht-fishbone-scroll'];
  const captureScroll=()=>({top:container.scrollTop,left:container.scrollLeft,inner:scrollSelectors.map(selector=>[selector,...Array.from(container.querySelectorAll?.(selector)||[]).map(el=>({top:el.scrollTop,left:el.scrollLeft}))])});
  const restoreScroll=snapshot=>{
    for(const [selector,...positions] of snapshot.inner) Array.from(container.querySelectorAll?.(selector)||[]).forEach((el,i)=>{if(positions[i]){el.scrollTop=positions[i].top;el.scrollLeft=positions[i].left;}});
    if(snapshot.top!==undefined)container.scrollTop=snapshot.top;
    if(snapshot.left!==undefined)container.scrollLeft=snapshot.left;
  };
  const initialScroll=captureScroll();
  const viewScroll=new Map();
  let explicitReveal=options.revealEvent||'';

  let scaleCleanup = () => {};
  let reorderCleanup = () => {};
  let suppressTabClickUntil = 0;
  const allEvents = [...(inputEvents || [])];
  const eventsById = new Map(allEvents.map(event => [event.id, event]));
  const connections = Array.isArray(options.connections) ? options.connections : [];
  const incomingLinks = new Map(), outgoingLinks = new Map();
  for (const link of connections) {
    if (!incomingLinks.has(link.to)) incomingLinks.set(link.to, []);
    if (!outgoingLinks.has(link.from)) outgoingLinks.set(link.from, []);
    incomingLinks.get(link.to).push(link); outgoingLinks.get(link.from).push(link);
  }
  const events = allEvents.filter(event => event.start).sort((a, b) => dateValue(a.start) - dateValue(b.start) || String(a.title).localeCompare(String(b.title)));
  const graphEvents=allEvents.filter(event=>event.start||event.kind==='factor');
  const groups = unique([...graphEvents.flatMap(event => event.groups || []), ...(options.analyses || []).flatMap(item => item.groups || [])]);
  const categories = unique(graphEvents.map(event => event.category).filter(Boolean));
  const selectedGroups = unique((Array.isArray(options.initialGroups) ? options.initialGroups : [options.initialGroup]).filter(value => typeof value === 'string').map(value => value.trim()));
  const state = {
    ignoreCase: options.ignoreCase !== false, collapsed: Boolean(options.initialCollapsed),
    groups: selectedGroups, group: selectedGroups.length === 1 ? selectedGroups[0] : '',
    excludedTags: unique(normalizeTags((Array.isArray(options.initialExcludedTags) ? options.initialExcludedTags : []).filter(value => typeof value === 'string'))),
    query: options.initialQuery || '',
    searchScope: ['title','summary','time','perspectives'].includes(options.initialSearchScope) ? options.initialSearchScope : 'all',
    category: options.initialCategory || '',
    match: ['all', 'any', 'none'].includes(options.initialMatch) ? options.initialMatch : 'all',
    important: Boolean(options.initialImportant),
    tag: options.initialTag || '', compare: Boolean(options.initialCompare),
    above: options.initialAbove || groups[0] || '', below: options.initialBelow || groups[1] || '',
    selected: options.initialSelected || '',
    graphSelected: options.initialGraphSelected || '',
    overviewGroup: options.initialOverviewGroup || '', analysis: options.initialAnalysis || '', graphMode: options.initialGraphMode || ((options.analyses || []).length ? 'analyses' : 'events'),
    mode: options.initialMode === 'scale' ? 'vertical' : ['vertical', 'wall', 'graph'].includes(options.initialMode) ? options.initialMode : 'cards'
  };
  const snapshotState = () => ({...state, groups:[...state.groups], excludedTags:[...state.excludedTags]});

  const node = (tag, className, text) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  };
  const button = (text, className, onClick, label) => {
    const element = node('button', className, text);
    element.type = 'button';
    if (label) element.setAttribute('aria-label', label);
    if (onClick) element.addEventListener('click', onClick);
    return element;
  };
  const root = node('section', `ht-root${options.embedded ? ' ht-embedded' : ''}`);
  root.setAttribute('aria-label', 'Historical timeline');
  container.replaceChildren(root);

  const header = node('header', 'ht-header');
  const headingGroup = node('div', 'ht-heading-group');
  headingGroup.append(node('div', 'ht-eyebrow', 'Historical timeline'));
  headingGroup.append(node('h2', 'ht-heading', options.title || 'A map of the past'));
  const headlineMeta = node('div', 'ht-headline-meta');
  headlineMeta.append(node('span', 'ht-total', `${events.length} ${events.length === 1 ? 'event' : 'events'}`));
  if (events.length) {
    headlineMeta.append(node('span', 'ht-meta-separator', '·'));
    headlineMeta.append(node('span', 'ht-range-label', totalRange(events)));
  } else {
    headlineMeta.append(node('span', 'ht-meta-separator', '·'));
    headlineMeta.append(node('span', '', 'Your story starts here'));
  }
  headingGroup.append(headlineMeta);
  header.append(headingGroup);
  if (!readOnly && !options.embedded && options.onCreate) {
    header.append(button('Add event', 'ht-button ht-primary', options.onCreate, 'Create a historical event'));
  }
  root.append(header);

  const sticky = node('div', 'ht-sticky-controls'); root.append(sticky);
  const toolbar = node('div', 'ht-toolbar');
  const groupField = multiSelectField('Timeline', groups, () => state.groups, values => {
    state.groups=values;state.group=values.length===1?values[0]:'';
  }, 'All timelines', 'Include timeline: ');
  const categoryField = selectField('Category', ['All categories', ''], categories, state.category);
  const tagField = selectField('Tag', ['All tags', ''], unique(graphEvents.flatMap(event => event.tags || [])), state.tag);
  const searchLabel = node('label', 'ht-field ht-search-field');
  searchLabel.append(node('span', 'ht-field-label', 'Search events'));
  const search = node('input', 'ht-search');
  search.type = 'search';
  search.placeholder = 'Search events…';
  search.value = state.query;
  search.setAttribute('aria-label', 'Search historical events');
  searchLabel.append(search);
  toolbar.append(groupField.wrapper, searchLabel, categoryField.wrapper, tagField.wrapper);
  sticky.append(toolbar);

  const filterActions = node('div', 'ht-filter-actions');
  const excludedTagField = multiSelectField('Exclude tags', unique(graphEvents.flatMap(event=>event.tags||[])), () => state.excludedTags,
    values => {state.excludedTags=values;}, 'No excluded tags', 'Exclude tag: ');
  excludedTagField.wrapper.classList.add('ht-excluded-tags-filter');
  const searchScopeLabel = node('label', 'ht-field');
  searchScopeLabel.append(node('span', 'ht-field-label', 'Search in'));
  const searchScope = node('select', 'ht-select'); searchScope.setAttribute('aria-label', 'Search in');
  for (const [value, text] of [['all','All fields'],['title','Title and aliases'],['summary','Summary'],['time','Time'],['perspectives','Historical perspectives']]) {
    const option = node('option', '', text); option.value = value; searchScope.append(option);
  }
  searchScope.value = state.searchScope;
  searchScope.addEventListener('change', () => { state.searchScope = searchScope.value; update(); });
  searchScopeLabel.append(searchScope); filterActions.append(searchScopeLabel,excludedTagField.wrapper);
  const match = node('select', 'ht-select'); match.setAttribute('aria-label', 'Filter matching');
  for (const [value, text] of [['all', 'All conditions are true'], ['any', 'Any condition is true'], ['none', 'No conditions are true']]) {
    const option = node('option', '', text); option.value = value; match.append(option);
  }
  match.value = state.match;
  match.addEventListener('change', () => { state.match = match.value; update(); });
  const importantLabel = node('label', 'ht-importance-field');
  const importantFilter = node('input', ''); importantFilter.type = 'checkbox'; importantFilter.checked = state.important;
  importantFilter.setAttribute('aria-label', 'Important events');
  importantFilter.addEventListener('change', () => { state.important = importantFilter.checked; update(); });
  importantLabel.append(importantFilter, node('span', '', 'Important events'));
  filterActions.append(match, importantLabel, button('Clear all filters', 'ht-button ht-secondary', clearFilters));
  sticky.append(filterActions);

  const viewbar = node('div', 'ht-viewbar');
  const count = node('div', 'ht-result-count');
  count.setAttribute('aria-live', 'polite');
  count.setAttribute('aria-atomic', 'true');
  const viewModes = node('div', 'ht-view-modes');
  viewModes.setAttribute('role', 'group');
  viewModes.setAttribute('aria-label', 'Timeline layout');
  const cardsButton = button('Chronicle', 'ht-mode-button', () => changeMode('cards'));
  const scaleButton = button('Timeline', 'ht-mode-button', () => changeMode('vertical'));
  const wallButton = button('Wall chart', 'ht-mode-button', () => changeMode('wall'));
  const graphButton = button('Cause & Effect', 'ht-mode-button', () => changeMode('graph'));
  const modeButtons = { cards: cardsButton, vertical: scaleButton, wall: wallButton, graph: graphButton };
  const modeNames = { cards: 'Chronicle', vertical: 'Timeline', wall: 'Wall chart', graph: 'Cause & Effect' };
  let viewOrder = [...new Set([...(Array.isArray(options.viewOrder) ? options.viewOrder : []), ...Object.keys(modeButtons)])].filter(key => modeButtons[key]);
  const applyOrder = () => viewModes.replaceChildren(...viewOrder.map(key => modeButtons[key]));
  applyOrder();
  viewbar.append(count, viewModes);
  const collapse = button('Hide filters', 'ht-edit-button', () => {
    state.collapsed = !state.collapsed; syncCollapsed(); options.onStateChange?.(snapshotState());
  });
  const syncCollapsed = () => {
    toolbar.hidden = filterActions.hidden = state.collapsed;
    if(state.collapsed){groupField.close();excludedTagField.close();}
    collapse.textContent = state.collapsed ? 'Show filters' : 'Hide filters';
    collapse.setAttribute('aria-expanded', String(!state.collapsed));
  };
  viewbar.append(collapse);
  if (options.onReadOnlyChange) {
    const modeToggle = button('', 'ht-reading-toggle ht-button ht-secondary', () => {
      if (disposed) return;
      readOnly = !readOnly;
      options.onReadOnlyChange(readOnly);
    }, readOnly ? 'Switch to editing mode' : 'Switch to reading mode');
    modeToggle.setAttribute('aria-pressed', String(readOnly));
    const icon = node('span', 'ht-reading-icon'); icon.setAttribute('aria-hidden', 'true');
    options.setIcon?.(icon, readOnly ? 'book-open' : 'pencil');
    modeToggle.append(icon, node('span', '', readOnly ? 'Reading' : 'Editing'));
    viewbar.append(modeToggle);
  }
  sticky.append(viewbar); syncCollapsed();
  const ignoreLabel = node('label', 'ht-importance-field');
  const ignoreCheck = node('input', ''); ignoreCheck.type='checkbox';ignoreCheck.checked=state.ignoreCase;ignoreCheck.setAttribute('aria-label','Ignore case');
  ignoreLabel.append(ignoreCheck,node('span','','Ignore case'));filterActions.append(ignoreLabel);
  ignoreCheck.addEventListener('change',async()=>{
    const previous=state.ignoreCase;state.ignoreCase=ignoreCheck.checked;update();
    try { await options.onIgnoreCaseChange?.(state.ignoreCase); } catch(error) {state.ignoreCase=previous;ignoreCheck.checked=previous;update();}
  });
  if (allEvents.some(event=>!event.start) && options.onUndated) viewbar.append(button('Undated events ('+allEvents.filter(event=>!event.start).length+')','ht-edit-button',()=>options.onUndated(open)));
  root.tabIndex = -1;
  if (options.onViewOrderChange) {
    const status = node('span', 'ht-order-status'); status.setAttribute('role', 'status'); root.append(status);
    let saving = false, gesture = null, timer = null;
    const finish = async (cancel = false) => {
      clearTimeout(timer); timer = null;
      const current = gesture; gesture = null;
      if (!current) return;
      modeButtons[current.key].classList.toggle('ht-tab-dragging', false);
      modeButtons[current.key].style.transform = '';
      for (const tab of Object.values(modeButtons)) tab.classList.toggle('ht-tab-drop-target',false);
      if (current.active && !cancel && current.pending !== undefined) { viewOrder = current.original.filter(key => key !== current.key); viewOrder.splice(current.pending,0,current.key); applyOrder(); }
      if (viewModes.hasPointerCapture?.(current.pointerId)) viewModes.releasePointerCapture(current.pointerId);
      if (!current.active) return;
      suppressTabClickUntil = Date.now() + 500;
      if (cancel) { viewOrder = current.original; applyOrder(); status.textContent = ''; return; }
      if (viewOrder.join() === current.original.join()) { status.textContent = ''; return; }
      saving = true;
      try { await options.onViewOrderChange([...viewOrder]); status.textContent = ''; }
      catch (error) { viewOrder = current.original; applyOrder(); status.textContent = error.message || 'Could not save order.'; }
      finally { saving = false; }
    };
    for (const [key, tab] of Object.entries(modeButtons)) {
      tab.title = 'Hold and drag to reorder. Keyboard: Alt + Left or Right.';
      tab.addEventListener('pointerdown', event => {
        if (saving || gesture || (event.button !== undefined && event.button !== 0)) return;
        gesture = { key, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false, original: [...viewOrder] };
        timer = setTimeout(() => {
          if (!gesture) return;
          gesture.zones = viewOrder.map(key => ({key,rect:modeButtons[key].getBoundingClientRect()}));
          gesture.active = true; tab.classList.toggle('ht-tab-dragging', true);
          viewModes.setPointerCapture?.(gesture.pointerId);
          status.textContent = 'Drag to reorder; release to save.';
        }, 400);
      });
      tab.addEventListener('contextmenu', event => { if (gesture) event.preventDefault(); });
      tab.addEventListener('keydown', async event => {
        if (event.key === 'Escape') { await finish(true); return; }
        if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || saving || gesture) return;
        event.preventDefault();
        const index = viewOrder.indexOf(key), target = index + (event.key === 'ArrowLeft' ? -1 : 1);
        if (target < 0 || target >= viewOrder.length) return;
        gesture = { key, active: true, original: [...viewOrder] };
        viewOrder.splice(index, 1); viewOrder.splice(target, 0, key); applyOrder();
        await finish(); tab.focus();
      });
    }
    viewModes.addEventListener('pointermove', event => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (!gesture.active) {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) finish(true);
        return;
      }
      event.preventDefault();
      modeButtons[gesture.key].style.transform = `translate(${event.clientX - gesture.x}px, ${event.clientY - gesture.y}px)`;
      const target = gesture.zones.find(({rect}) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top - 30 && event.clientY <= rect.bottom + 30);
      gesture.pending = target ? gesture.original.indexOf(target.key) : undefined;
      for (const [key,tab] of Object.entries(modeButtons)) tab.classList.toggle('ht-tab-drop-target', key === target?.key && key !== gesture.key);

    });
    viewModes.addEventListener('pointerup', () => finish());
    viewModes.addEventListener('pointercancel', () => finish(true));
    viewModes.addEventListener('lostpointercapture', () => {if(gesture) finish(true);});
    viewModes.addEventListener('pointerleave', () => { if (gesture && !gesture.active) finish(true); });
    reorderCleanup = () => { clearTimeout(timer); gesture = null; };
  }


  const compareControls = node('div', 'ht-compare-controls');
  const compareLabel = node('label', 'ht-compare-toggle');
  const compareCheck = node('input', ''); compareCheck.type = 'checkbox'; compareCheck.checked = state.compare;
  compareLabel.append(compareCheck, node('span', '', 'Compare timelines'));
  const aboveField = selectField('Above the line', ['Choose a timeline', ''], groups, state.above);
  const belowField = selectField('Below the line', ['Choose a timeline', ''], groups, state.below);
  compareControls.append(compareLabel, aboveField.wrapper, belowField.wrapper);
  sticky.append(compareControls);
  compareCheck.addEventListener('change', () => { state.compare = compareCheck.checked; update(); });
  aboveField.select.addEventListener('change', () => { state.above = aboveField.select.value; update(); });
  belowField.select.addEventListener('change', () => { state.below = belowField.select.value; update(); });
  tagField.select.addEventListener('change', () => { state.tag = tagField.select.value; update(); });

  if (options.errors && options.errors.length) {
    const details = node('details', 'ht-diagnostics');
    details.append(node('summary', '', `${options.errors.length} ${options.errors.length === 1 ? 'note needs' : 'notes need'} attention`));
    details.append(node('p', '', 'These notes could not be displayed. Correct their timeline properties to include them.'));
    const list = node('ul', 'ht-error-list');
    options.errors.forEach(error => {
      const item = node('li', '');
      item.append(node('strong', '', error.path || 'Untitled note'), node('span', '', ` — ${error.message}`));
      list.append(item);
    });
    details.append(list);
    root.append(details);
  }
  const results = node('div', 'ht-results');
  root.append(results);

  categoryField.select.addEventListener('change', () => { state.category = categoryField.select.value; update(); });
  search.addEventListener('input', () => { state.query = search.value; update(); });

  function multiSelectField(label, names, getSelected, setSelected, emptyLabel, optionLabel) {
    const wrapper=node('div','ht-field ht-timeline-filter');
    wrapper.append(node('span','ht-field-label',label));
    const toggle=button('','ht-select ht-timeline-toggle',()=>setOpen(panel.hidden),label);
    toggle.setAttribute('aria-expanded','false');
    const panel=node('div','ht-timeline-options');panel.hidden=true;
    panel.setAttribute('role','group');panel.setAttribute('aria-label',label==='Timeline'?'Choose timelines':'Choose tags to exclude');
    const choices=[];
    const setOpen=open=>{
      if(disposed || toggle.disabled)open=false;
      panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));
    };
    const sync=()=>{
      const selected=getSelected();
      toggle.textContent=selected.length?selected.join(', '):emptyLabel;
      toggle.setAttribute('aria-description',toggle.textContent);
      for(const {input,value} of choices)input.checked=value?selected.includes(value):!selected.length;
    };
    for(const value of ['',...unique([...names,...getSelected()])]){
      const row=node('label','ht-timeline-option');
      const input=node('input','');input.type='checkbox';input.setAttribute('aria-label',value?optionLabel+value:emptyLabel);
      row.append(input,node('span','',value||emptyLabel));panel.append(row);choices.push({input,value});
      input.addEventListener('change',()=>{
        if(disposed||toggle.disabled)return;
        const selected=getSelected();
        setSelected(value?unique(input.checked?[...selected,value]:selected.filter(item=>item!==value)):[]);
        sync();update();
      });
    }
    const close=()=>{setOpen(false);toggle.focus({preventScroll:true});};
    const done=button('Done','ht-timeline-done',close);panel.append(done);
    const escape=event=>{
      if(panel.hidden||event.key!=='Escape'||event.isComposing||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return false;
      event.preventDefault();event.stopPropagation();close();return true;
    };
    const focusTargets=[toggle,...choices.map(choice=>choice.input),done];
    const releaseScopes=focusTargets.map(target=>options.bindSearchEscape?.(target,escape));
    wrapper.addEventListener('keydown',event=>{
      if(escape(event)||event.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;
      const inputs=choices.map(choice=>choice.input),index=inputs.indexOf(doc.activeElement);
      if(doc.activeElement===toggle&&['ArrowDown','ArrowUp'].includes(event.key)){
        event.preventDefault();setOpen(true);inputs[event.key==='ArrowUp'?inputs.length-1:0].focus({preventScroll:true});
      }else if(!panel.hidden&&index>=0&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?inputs.length-1:Math.max(0,Math.min(inputs.length-1,index+(event.key==='ArrowDown'?1:-1)));
        inputs[next].focus({preventScroll:true});inputs[next].scrollIntoView?.({block:'nearest'});
      }
    });
    const outside=event=>{if(!wrapper.contains(event.target))setOpen(false);};
    doc.addEventListener?.('pointerdown',outside);
    wrapper.addEventListener('focusout',event=>{if(event.relatedTarget&&!wrapper.contains(event.relatedTarget))setOpen(false);});
    wrapper.append(toggle,panel);sync();
    return {wrapper, toggle, sync, close:()=>setOpen(false), setDisabled(value){toggle.disabled=value;for(const {input} of choices)input.disabled=value;if(value)setOpen(false);},
      dispose(){doc.removeEventListener?.('pointerdown',outside);for(const release of releaseScopes)release?.();}};
  }

  function selectField(label, allOption, values, selected) {
    const wrapper = node('label', 'ht-field');
    wrapper.append(node('span', 'ht-field-label', label));
    const select = node('select', 'ht-select');
    select.setAttribute('aria-label', label);
    const addOption = (text, value) => {
      const option = node('option', '', text);
      option.value = value;
      select.append(option);
    };
    addOption(allOption[0], allOption[1]);
    // Keep a saved filter visible even if its last event has been removed.
    unique([...values, ...(selected ? [selected] : [])]).forEach(value => addOption(value, value));
    select.value = selected;
    wrapper.append(select);
    return { wrapper, select };
  }

  function changeMode(mode) {
    if (Date.now() < suppressTabClickUntil) return;
    viewScroll.set(state.mode,captureScroll());
    state.mode = mode;
    update(true, true);
    if(viewScroll.has(mode))restoreScroll(viewScroll.get(mode));
  }

  function clearFilters(navigation = false) {
    state.match = 'all'; match.value = 'all'; state.important = false; importantFilter.checked = false;
    state.compare = false; compareCheck.checked = false;
    state.group = ''; state.groups = []; state.excludedTags = [];
    state.category = '';
    state.query = ''; state.searchScope = 'all'; searchScope.value = 'all'; state.tag = ''; tagField.select.value = '';
    groupField.sync(); excludedTagField.sync();
    categoryField.select.value = '';
    search.value = '';
    update(true, navigation === true);
  }

  function update(notify = true, navigation = false) {
    const normalized = value => state.ignoreCase ? value.toLocaleLowerCase() : value;
    const words = normalized(searchText(state.query)).trim().split(/\s+/).filter(Boolean);
    const activeEvents=state.mode==='graph'?graphEvents:events;
    const excludedTags=new Set(state.excludedTags);
    const filtered = activeEvents.filter(event => {
      // Exclusions are a veto, independent of All/Any/None and comparison.
      if((event.tags||[]).some(tag=>excludedTags.has(tag)))return false;
      const conditions = [];
      if (!(state.mode === 'wall' && state.compare) && state.groups.length) conditions.push(state.groups.some(group=>(event.groups || []).includes(group)));
      if (state.category) conditions.push(event.category === state.category);
      if (state.tag) conditions.push((event.tags || []).includes(state.tag));
      if (state.important) conditions.push(Boolean(event.important));
      if (state.mode === 'wall' && state.compare && !(event.groups || []).some(group => group === state.above || group === state.below)) return false;
      if (words.length) {
        const titleText = [event.title, ...(event.aliases || [])];
        const timeText = [dateLabel(event.start), event.start?.canonical, event.end && dateLabel(event.end), event.end?.canonical];
        const perspectiveText = (event.perspectives || []).flatMap(item => [item.historian, item.interpretation, item.source]);
        const searchFields = state.searchScope === 'title' ? titleText : state.searchScope === 'summary' ? [event.summary] : state.searchScope === 'time' ? timeText : state.searchScope === 'perspectives' ? perspectiveText :
          [...titleText, ...perspectiveText, event.summary, event.location, event.source, event.category, event.path, ...timeText, ...(event.groups || []), ...(event.tags || []).map(tag => '#' + tag)];
        const searchable = normalized(searchFields.filter(Boolean).join(' ').normalize('NFKC'));
        conditions.push(words.every(word => searchable.includes(word)));
      }
      if (!conditions.length) return true;
      return state.match === 'any' ? conditions.some(Boolean) : state.match === 'none' ? !conditions.some(Boolean) : conditions.every(Boolean);
    });
    count.replaceChildren(node('strong', '', `${filtered.length} ${filtered.length === 1 ? 'event' : 'events'}`));
    count.append(node('span', '', filtered.length !== activeEvents.length ? ` of ${activeEvents.length} · oldest first` : ' · oldest first'));
    cardsButton.setAttribute('aria-pressed', String(state.mode === 'cards'));
    scaleButton.setAttribute('aria-pressed', String(state.mode === 'vertical'));
    graphButton.setAttribute('aria-pressed', String(state.mode === 'graph'));
    wallButton.setAttribute('aria-pressed', String(state.mode === 'wall'));
    compareControls.hidden = state.mode !== 'wall';
    aboveField.wrapper.hidden = belowField.wrapper.hidden = !state.compare;
    groupField.setDisabled(state.mode === 'wall' && state.compare);
    scaleCleanup(); scaleCleanup = () => {};
    results.replaceChildren();
    if (state.mode === 'wall' && state.compare && (!state.above || !state.below || state.above === state.below)) {
      results.append(node('p', 'ht-wall-help', 'Choose two different timelines to compare, or turn off Compare timelines.'));
    } else if (state.mode === 'graph') renderGraph(filtered);
    else if (!filtered.length) renderEmpty(events.length > 0);
    else if (state.mode === 'vertical') renderVertical(filtered);
    else if (state.mode === 'wall') renderWall(filtered);
    else renderCards(filtered);
    revealSelected();
    if (notify && options.onStateChange) options.onStateChange(snapshotState(), {navigation});
  }

  function renderEmpty(isFiltered) {
    const empty = node('div', 'ht-empty');
    empty.append(node('div', 'ht-empty-mark', isFiltered ? '—' : '01'));
    empty.append(node('h3', '', isFiltered ? 'No events match these filters' : 'Every history begins with an event'));
    empty.append(node('p', '', isFiltered ? 'Try a different search or show all timelines and categories.' : 'Add a date, give the moment a name, and connect it to your notes. BCE dates and events spanning years are welcome.'));
    if (isFiltered) empty.append(button('Clear filters', 'ht-button ht-secondary', clearFilters));
    else if (!readOnly && !options.embedded && options.onCreate) empty.append(button('Create your first event', 'ht-button ht-primary', options.onCreate));
    results.append(empty);
  }

  function renderCards(filtered) {
    const list = node('ol', 'ht-chronicle');
    list.setAttribute('aria-label', 'Events in chronological order');
    filtered.forEach(event => {
      const item = node('li', 'ht-chronicle-item');
      const date = node('div', 'ht-date-column');
      date.append(node('span', 'ht-event-date', dateLabel(event.start)));
      if (event.end) date.append(node('span', 'ht-event-end', `to ${dateLabel(event.end)}`));
      const card = node('article', 'ht-event-card');
      card.setAttribute('data-event-id',event.id);
      if (event.important) card.classList.add('ht-important');
      const top = node('div', 'ht-card-top');
      const title = button(event.title || 'Untitled event', 'ht-event-title', () => open(event), `Open event: ${event.title || 'Untitled event'}`);
      top.append(title);
      if (!readOnly && options.onEdit && !options.embedded) top.append(button('Edit', 'ht-edit-button', () => options.onEdit(event), `Edit event: ${event.title || 'Untitled event'}`));
      card.append(top);
      const tags = node('div', 'ht-tags');
      if (event.category) tags.append(categoryBadge(event.category));
      (event.groups || []).forEach(group => tags.append(node('span', 'ht-group-tag', group)));
      (event.tags || []).forEach(tag => tags.append(node('span', 'ht-event-tag', '#' + tag)));
      if (tags.childNodes.length) card.append(tags);
      if (event.summary) card.append(node('p', 'ht-event-summary', event.summary));
      if (event.location || event.source) {
        const facts = node('dl', 'ht-event-facts');
        if (event.location) addFact(facts, 'Place', event.location);
        if (event.source) addFact(facts, 'Source', event.source);
        card.append(facts);
      }
      const notePath = node('div', 'ht-note-path', event.storage === 'timeline' ? 'Timeline only · no note' : event.path || '');
      notePath.title = event.path || '';
      if (event.path || event.storage === 'timeline') card.append(notePath);
      item.append(date, card);
      list.append(item);
    });
    results.append(list);
    const end = node('div', 'ht-chronicle-end', 'End of this timeline');
    results.append(end);
  }

  function addFact(facts, label, value) {
    const pair = node('div', 'ht-fact');
    pair.append(node('dt', '', label), node('dd', '', value));
    facts.append(pair);
  }

  function categoryBadge(category) {
    return node('span', `ht-category ht-color-${colorIndex(category)}`, category);
  }

  function open(event) {
    if (disposed) return;
    if (readOnly) {
      // Linked navigation reuses the native preview; retain only its current
      // presentation's disposer so renderer teardown cannot leave stale links.
      closeReadPreview = options.onReadEvent?.(event, panel => { if (!disposed) renderDetails(event, panel, true); });
    }
    else options.onOpen?.(event);
  }

  function renderWall(filtered) {
    const section = node('div', 'ht-wall');
    const viewport = node('div', 'ht-wall-viewport');
    const scroll = node('div', 'ht-wall-scroll'); scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Wall chart. Scroll horizontally or vertically to explore.');
    const plot = node('div', 'ht-wall-plot');
    const measuredItems = [], yearLabels = [];
    const years = new Map();
    const periods = filtered.filter(event => event.end || ['decade', 'century'].includes(event.start.precision));
    const points = filtered.filter(event => !periods.includes(event));
    const lastYear = event => {
      const coordinate = Math.ceil(eventEnd(event)) - 1;
      return coordinate <= 0 ? coordinate - 1 : coordinate;
    };
    for (const event of filtered) {
      if (!years.has(event.start.year)) years.set(event.start.year, []);
      if (periods.includes(event)) years.set(lastYear(event), years.get(lastYear(event)) || []);
    }
    for (const event of points) years.get(event.start.year).push(event);
    const currentYear = new Date().getFullYear();
    if (!years.has(currentYear)) years.set(currentYear, []);
    const orderedYears = [...years.keys()].sort((a, b) => a - b);
    const isShared = event => state.compare && (event.groups || []).includes(state.above) && (event.groups || []).includes(state.below);
    const onSide = (event, index, side) => state.compare
      ? (isShared(event) ? side === 'above' : (event.groups || []).includes(state[side]))
      : side === (index % 2 ? 'below' : 'above');
    const membersFor = (year, index, side, shared) => years.get(year).filter(event =>
      Boolean(isShared(event)) === shared && onSide(event, index, side));
    // Shared items reserve the innermost space. Within each group, short
    // periods stay inside longer overlapping periods as in the normal chart.
    const occupied = { above: [], below: [] };
    const lanes = { above: [], below: [] }, pointLanes = [];
    for (const shared of (state.compare ? [true, false] : [false])) {
      for (const side of ['above', 'below']) orderedYears.forEach((year, index) => {
        const members = membersFor(year, index, side, shared);
        if (!members.length) return;
        let level = 0;
        while (Array.from({length:members.length}, (_, offset) => occupied[side][level + offset])
          .some(row => row?.some(range => index >= range.first && index <= range.last))) level++;
        members.forEach((_, offset) => (occupied[side][level + offset] ||= []).push({first:index, last:index}));
        pointLanes.push({members, year, index, side, shared, level});
      });
      periods.map((event, index) => ({ event, index }))
        .filter(({event}) => Boolean(isShared(event)) === shared)
        .sort((a, b) => (eventEnd(a.event) - dateValue(a.event.start)) - (eventEnd(b.event) - dateValue(b.event.start)))
        .forEach(({ event, index }) => {
        const first = orderedYears.indexOf(event.start.year);
        const last = orderedYears.indexOf(lastYear(event));
        for (const side of ['above', 'below']) {
          if (!onSide(event, index, side)) continue;
          let level = Math.max(0, ...lanes[side].filter(item => first <= item.last && last >= item.first).map(item => item.level + 1));
          while (occupied[side][level]?.some(range => first <= range.last && last >= range.first)) level++;
          (occupied[side][level] ||= []).push({ first, last });
          lanes[side].push({ event, level, first, last, index, shared });
        }
      });
    }
    for (const side of ['above', 'below']) lanes[side].sort((a, b) => a.index - b.index);
    const aboveRows = Math.max(1, occupied.above.length);
    const belowRows = Math.max(1, occupied.below.length);
    const axisRow = aboveRows + 1;
    plot.style.width = Math.max(720, years.size * 240 + 80) + 'px';
    plot.style.gridTemplateColumns = `repeat(${years.size}, minmax(0, 1fr))`;
    plot.style.gridTemplateRows = `${'72px '.repeat(aboveRows)}44px${' 72px'.repeat(belowRows)}`;
    const axis = node('div', 'ht-wall-axis'); axis.style.gridRow = String(axisRow); plot.append(axis);
    orderedYears.forEach((year, index) => {
      const column = String(index + 1);
      const yearText = `${Math.abs(year)} ${year < 0 ? 'BCE' : 'CE'}`;
      const label = node('div', 'ht-wall-year', yearText);
      label.style.gridColumn = column; label.style.gridRow = String(axisRow); plot.append(label);
      yearLabels.push(label);
    });
    pointLanes.sort((a,b) => a.index - b.index);
    for (const {members, year, index, side, shared, level} of pointLanes) {
      const stack = node('div', 'ht-wall-stack ht-wall-' + side);
      const depth = members.length;
      stack.style.gridColumn = String(index + 1);
      stack.style.gridRow = side === 'above'
        ? `${axisRow - level - depth} / ${axisRow - level}`
        : `${axisRow + 1 + level} / ${axisRow + 1 + level + depth}`;
      stack.setAttribute('role', 'group'); stack.setAttribute('aria-label', `${Math.abs(year)} ${year < 0 ? 'BCE' : 'CE'}, ${shared ? 'both timelines' : side + ' the line'}`);
      // Earliest precise dates start next to the axis; a whole month/year
      // follows its dated entries rather than pretending to be January 1.
      const orderedMembers = [...members].sort((a, b) =>
        (a.start.month ?? 13) - (b.start.month ?? 13) ||
        (a.start.day ?? 32) - (b.start.day ?? 32) || a.title.localeCompare(b.title));
      if (side === 'above') orderedMembers.reverse();
      for (const event of orderedMembers) {
        const item = node('article', 'ht-wall-item');
        const title = button(event.title, 'ht-wall-title', () => open(event), 'Open event: ' + event.title);
        if (event.important) title.classList.add('ht-important');
        title.title = event.title + ' · ' + dateRange(event) + (event.summary ? '\n' + event.summary : '');
        item.append(title);
        if (shared) item.append(node('span', 'ht-wall-shared-label', 'Both timelines'));
        stack.append(item);
      }
      plot.append(stack);
      measuredItems.push({ element:stack, first:index, last:index, side, kind:'points', shared });
    }
    for (const side of ['above', 'below']) lanes[side].forEach(({ event, level, shared }) => {
      const first = orderedYears.indexOf(event.start.year) + 1;
      const last = orderedYears.indexOf(lastYear(event)) + 1;
      const span = node('div', 'ht-wall-period');
      span.style.gridColumn = `${first} / ${last + 1}`;
      span.style.gridRow = String(side === 'above' ? axisRow - 1 - level : axisRow + 1 + level);
      const title = button(event.title, 'ht-wall-title', () => open(event), `Open event: ${event.title}, ${dateRange(event)}`);
      if (event.important) title.classList.add('ht-important');
      title.title = `${event.title} · ${dateRange(event)}`;
      const range = node('span', 'ht-wall-period-date', dateRange(event));
      const line = node('span', 'ht-wall-period-line');
      const inset = last === first ? '25%' : `calc((100% - ${(last - first) * 24}px) / ${(last - first + 1) * 2})`;
      line.style.marginLeft = inset; line.style.marginRight = inset;
      span.append(title, range, line);
      if (shared) span.append(node('span', 'ht-wall-shared-label', 'Both timelines'));
      plot.append(span);
      measuredItems.push({ element: span, first: first - 1, last: last - 1, side, kind: 'period', shared, duration: eventEnd(event) - dateValue(event.start) });
    });
    scroll.append(plot); viewport.append(scroll); section.append(viewport); results.append(section);

    // The grid is an initial layout for hidden/unmeasurable panes. Once mounted,
    // pack actual rendered heights, rather than reserving 72px per short title.
    const win = doc.defaultView;
    let frame = null, disposed = false, zoom = null;
    if (!options.isMobile) {
      const recentre = button('', 'ht-wall-recentre clickable-icon', () => {
        if (disposed || !scroll.clientHeight || !axis.getBoundingClientRect) return;
        // Use the live axis position: comparison sides can have very different
        // heights. Move only this viewport vertically, retaining the year in view.
        const axisRect = axis.getBoundingClientRect(), viewportRect = scroll.getBoundingClientRect();
        const target = scroll.scrollTop + axisRect.top + axisRect.height / 2
          - viewportRect.top - scroll.clientTop - scroll.clientHeight / 2;
        scroll.scrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, target));
      }, 'Recentre on time axis');
      recentre.title = 'Return to the time axis without changing the years in view';
      const icon = node('span', 'ht-recentre-icon');
      icon.setAttribute('aria-hidden', 'true');
      if (options.setIcon) options.setIcon(icon, 'locate-fixed');
      else {
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':'2', 'stroke-linecap':'round', focusable:'false'})) svg.setAttribute(key, value);
        for (const [tag, attrs] of [['circle', {cx:'12',cy:'12',r:'7'}], ['circle', {cx:'12',cy:'12',r:'3'}], ['path', {d:'M12 2v3 M12 19v3 M2 12h3 M19 12h3'}]]) {
          const shape = doc.createElementNS('http://www.w3.org/2000/svg', tag);
          for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
          svg.append(shape);
        }
        icon.append(svg);
      }
      recentre.append(icon);
      viewport.append(recentre);
    }
    // getBoundingClientRect includes transforms; packing must use layout pixels.
    const layoutSize = (element, dimension) => {
      if (!zoom) return element.getBoundingClientRect()[dimension];
      const offset = dimension === 'width' ? element.offsetWidth : element.offsetHeight;
      return Number.isFinite(offset) ? offset : element.getBoundingClientRect()[dimension] / (zoom?.getScale() || 1);
    };
    const measure = () => {
      frame = null;
      if (disposed || !plot.getBoundingClientRect) return;
      const width = layoutSize(plot, 'width');
      if (!width) return;
      plot.classList.add('ht-wall-measured');
      const step = (width - 80 + 24) / orderedYears.length;
      for (const item of measuredItems) {
        item.element.style.left = `${40 + item.first * step}px`;
        item.element.style.width = `${(item.last - item.first + 1) * step - 24}px`;
      }
      // Measure all natural heights after setting widths, then apply positions.
      const placements = packWallItems(measuredItems.map(item => ({ ...item,
        height: item.empty ? 0 : layoutSize(item.element, 'height')
      })));
      const extent = side => Math.max(22, ...placements.filter(item => item.side === side).map(item => item.offset + item.height));
      const axisY = 16 + extent('above');
      plot.style.height = `${axisY + extent('below') + 16}px`;
      axis.style.top = `${axisY}px`;
      yearLabels.forEach((label, index) => {
        label.style.left = `${40 + index * step + (step - 24) / 2}px`;
        label.style.top = `${axisY}px`;
      });
      for (const item of placements) item.element.style.top = `${item.side === 'above' ? axisY - item.offset - item.height : axisY + item.offset}px`;
      zoom?.refresh();
    };
    const schedule = () => {
      if (!disposed && frame === null && win?.requestAnimationFrame) frame = win.requestAnimationFrame(measure);
    };
    measure();
    const touchZoom = zoomOptions('wall');
    if (touchZoom) {
      zoom = mountChartZoom(scroll, plot, { ...touchZoom, getSize: () => ({
        width: parseFloat(plot.style.width),
        height: parseFloat(plot.style.height) || plot.offsetHeight || 1
      }) });
      section.insertBefore(zoom.controls, viewport);
    }
    const observer = win?.ResizeObserver ? new win.ResizeObserver(schedule) : null;
    observer?.observe(plot);
    for (const item of measuredItems) if (!item.empty) observer?.observe(item.element);
    scaleCleanup = () => { disposed = true; observer?.disconnect(); if (frame !== null) win?.cancelAnimationFrame(frame); zoom?.destroy(); };

  }

  function navigateEvent(event, mode) {
    viewScroll.set(state.mode,captureScroll());
    state.mode=mode;
    if(mode==='vertical'){state.selected=event.id;explicitReveal=event.id;}
    else {
      state.graphSelected=event.id;
      // Prefer a saved analysis containing the same event; keep its branch context.
      const contains=analysis=>analysis.headEventId===event.id||(analysis.branches||[]).some(branch=>branch.eventId===event.id||(branch.factors||[]).some(factor=>factor.eventId===event.id));
      const saved=(options.analyses||[]).filter(contains);
      const analysis=saved.find(item=>item.id===state.analysis)||saved[0];
      state.graphMode=analysis?'analyses':'events';if(analysis)state.analysis=analysis.id;
      state.overviewGroup=event.groups?.[0]||'';
    }
    clearFilters(true);
  }

  function renderDetails(event, panel, preview = false) {
    panel.append(node('div', 'ht-eyebrow', 'Event details'), node('h3', 'ht-detail-heading', event.title), node('p', 'ht-detail-date', dateRange(event)));
    if (event.aliases?.length) panel.append(node('p', 'ht-detail-meta', 'Also known as: ' + event.aliases.join(' · ')));
    if (event.important) panel.append(node('span', 'ht-important ht-detail-badge', 'Important event'));
    const meta = [...(event.groups || []), ...(event.tags || []).map(tag => '#' + tag)].join(' · ');
    if (meta) panel.append(node('p', 'ht-detail-meta', meta));
    if (event.summary) panel.append(node('p', 'ht-detail-summary', event.summary));
    if (event.location) panel.append(node('p', '', 'Location: ' + event.location));
    if (event.source) panel.append(node('p', 'ht-detail-source', 'Source: ' + event.source));
    if (event.perspectives?.length) {
      panel.append(node('h4','','Historical perspectives'));
      for(const perspective of event.perspectives) {const card=node('div','ht-perspective-card');card.append(node('strong','',perspective.historian),node('p','',perspective.interpretation),node('p','ht-detail-source',perspective.source));panel.append(card);}
    }
    const actions = node('div', 'ht-detail-actions');
    if (!readOnly && !preview && options.onEdit) actions.append(button('Edit event', 'ht-button ht-secondary', () => options.onEdit(event)));
    if (event.path) actions.append(button('Open note', 'ht-button ht-secondary', () => { if (!disposed) (options.onOpenNote || options.onOpen)?.(event); }));
    if (!readOnly && !preview && options.onConnect) { actions.append(button('Add cause', 'ht-button ht-primary', () => options.onConnect(event, undefined, 'incoming'))); actions.append(button('Add consequence', 'ht-button ht-secondary', () => options.onConnect(event, undefined, 'outgoing'))); }
    if(!preview && state.mode==='vertical') actions.append(button('Show in Cause & Effect','ht-button ht-secondary',()=>navigateEvent(event,'graph')));
    else if(!preview && state.mode==='graph'&&event.start) actions.append(button('Show in Timeline','ht-button ht-secondary',()=>navigateEvent(event,'vertical')));
    panel.append(actions, node('h4', '', 'Connections'));
    let count = 0;
    for (const [title, direction] of [['Contributing causes', 'incoming'], ['Consequences / related events', 'outgoing']]) {
      const links = (direction === 'incoming' ? incomingLinks : outgoingLinks).get(event.id) || [];
      if (!links.length) continue;
      panel.append(node('h5', '', title));
      for (const link of links) {
        count++;
        const otherId = direction === 'incoming' ? link.from : link.to;
        const other = eventsById.get(otherId);
        const row = node('div', 'ht-connection-row');
        if (direction === 'outgoing') row.append(node('span', 'ht-connection-relation', link.relation + (link.disputed ? ' · disputed' : '')));
        else if (link.disputed) row.append(node('span', 'ht-connection-relation', 'Disputed interpretation'));
        if (other) row.append(button(other.title, 'ht-connection-link', () => {
          // Undated events and expanded reading previews remain browsable
          // without falling through to the event editor.
          if (readOnly && (preview || (!other.start && other.kind !== 'factor') || ['cards', 'wall'].includes(state.mode))) { open(other); return; }
          // Explicit navigation to a linked event clears filters that would hide it.
          if (!other.start && other.kind!=='factor') { options.onEdit?.(other); return; }
          if(other.kind==='factor'){state.mode='graph';state.graphMode='events';}
          if(state.mode==='graph') state.graphSelected=other.id; else state.selected=other.id;
          clearFilters(true);
        }));
        else row.append(node('span', '', 'Event unavailable (deleted or outside the current folder)'));
        if (link.explanation) row.append(node('p', '', link.explanation));
        if (link.source) row.append(node('p', 'ht-detail-source', 'Source: ' + link.source));
        if (!readOnly && !preview && options.onConnect) row.append(button('Edit connection', 'ht-edit-button', () => options.onConnect(event, link)));
        panel.append(row);
      }
    }
    if (!count) panel.append(node('p', 'ht-detail-meta', readOnly ? 'No connections yet.' : 'No connections yet. Add a contributing cause or consequence.'));
  }

  function renderVertical(filtered) {
    const selected = filtered.find(event => event.id === state.selected) || filtered[0];
    state.selected = selected.id;
    const layout = node('div', 'ht-vertical-layout');
    const list = node('div', 'ht-vertical-list'); list.setAttribute('aria-label', 'Chronological event list');
    list.setAttribute('aria-description', options.isMobile ? 'Use ↑ and ↓ to select events' : 'Use ↑ / ↓ or scroll here to select events');
    const panel = node('article', 'ht-detail-panel');
    const items = [];
    let active = true;
    const select = event => {
      if (!active || disposed || state.selected === event.id) return;
      // Keep the list mounted so its scroll position and keyboard focus survive.
      state.selected = event.id;
      for (const entry of items) {
        const current = entry.id === event.id;
        entry.item.setAttribute('aria-pressed', String(current));
        entry.item.tabIndex = current ? 0 : -1;
      }
      panel.replaceChildren(); renderDetails(event, panel);
      options.onStateChange?.(snapshotState(), {navigation:true});
    };
    for (const event of filtered) {
      const item = button('', 'ht-vertical-item', () => select(event), `Select event: ${event.title}`);
      item.setAttribute('data-event-id',event.id);
      items.push({ id:event.id, item });
      item.setAttribute('aria-pressed', String(event.id === selected.id));
      item.tabIndex = event.id === selected.id ? 0 : -1;
      if (event.important) item.classList.add('ht-important');
      item.append(node('span', 'ht-vertical-dot'), node('strong', '', event.title), node('span', 'ht-vertical-date', dateRange(event)));
      list.append(item);
    }
    const editable = target => {
      for (let el = target; el; el = el.parentElement) {
        if (['INPUT','TEXTAREA','SELECT'].includes(String(el.tagName).toUpperCase()) || el.isContentEditable ||
            ['textbox','combobox','searchbox'].includes(el.getAttribute?.('role'))) return true;
      }
      return false;
    };
    const moveTo = index => {
      index = Math.max(0, Math.min(filtered.length - 1, index));
      const event = filtered[index];
      if (!active || disposed || event.id === state.selected) return;
      select(event);
      const item = items[index].item;
      item.focus({preventScroll:true});
      // scrollIntoView can also move Obsidian's outer pane. Reveal only within
      // the list, leaving the detail panel and the surrounding page stationary.
      if (list.getBoundingClientRect && item.getBoundingClientRect) {
        const viewport = list.getBoundingClientRect(), row = item.getBoundingClientRect();
        const top = viewport.top + (list.clientTop || 0), bottom = top + list.clientHeight;
        if (row.top < top || row.height > list.clientHeight) list.scrollTop = Math.max(0, list.scrollTop + row.top - top);
        else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
      }
    };
    const modified = event => event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    const onKey = event => {
      if (!active || disposed || event.defaultPrevented || event.isComposing || modified(event) || editable(event.target)) return;
      let index = filtered.findIndex(item => item.id === state.selected);
      if (event.key === 'ArrowDown') index++;
      else if (event.key === 'ArrowUp') index--;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = filtered.length - 1;
      else return;
      event.preventDefault(); event.stopPropagation();
      moveTo(index);
    };
    let wheelDelta = 0, wheelAt = -Infinity, steppedAt = -Infinity;
    const onWheel = event => {
      if (!active || disposed || event.defaultPrevented || modified(event) || editable(event.target) || editable(doc.activeElement) ||
          !Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX || 0) >= Math.abs(event.deltaY)) return;
      event.preventDefault(); event.stopPropagation();
      const now = Date.now();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientHeight : 1);
      if (now - wheelAt > 220 || Math.sign(delta) !== Math.sign(wheelDelta)) wheelDelta = 0;
      wheelAt = now;
      // Accumulate small trackpad movements, but never turn one large packet
      // into multiple selections. Drop inertia during the short cooldown.
      if (now - steppedAt < 260) { wheelDelta = 0; return; }
      wheelDelta += delta;
      if (Math.abs(wheelDelta) < 48) return;
      const direction = Math.sign(wheelDelta); wheelDelta = 0; steppedAt = now;
      moveTo(filtered.findIndex(item => item.id === state.selected) + direction);
    };
    list.addEventListener('keydown', onKey);
    if (!options.isMobile) list.addEventListener('wheel', onWheel, {passive:false});
    scaleCleanup = () => {
      active = false;
      list.removeEventListener('keydown', onKey);
      list.removeEventListener('wheel', onWheel);
    };
    const currentYear = new Date().getFullYear();
    list.append(node('div', 'ht-vertical-present', `Present · ${currentYear}`));
    renderDetails(selected, panel);
    layout.append(list, panel); results.append(layout);
  }

  function renderGraph(filtered) {
    const analyses = (options.analyses || []).filter(item => !state.groups.length || state.groups.some(group=>(item.groups || []).includes(group)));
    const tools=node('div','ht-analysis-toolbar');
    const view=selectField('Diagram type',['Saved analyses','analyses'],['events'],'');
    view.select.value=state.graphMode;
    // Give the existing-event view a human-readable label.
    for(const option of view.select.children) if(option.value==='events') option.textContent='Timeline overview';
    view.select.setAttribute('aria-label','Cause and effect diagram type');
    view.select.addEventListener('change',()=>{state.graphMode=view.select.value;update(true,true);});tools.append(view.wrapper);
    const afterSave = saved => { state.analysis=saved.id;state.graphMode='analyses';update(); };
    if(!readOnly && options.onAnalysisEdit)tools.append(button('New analysis','ht-button ht-primary',()=>options.onAnalysisEdit(undefined,[...state.groups],afterSave)));
    results.append(tools);
    let analysis;
    if(state.graphMode==='analyses'){
      results.append(node('p','ht-detail-meta','The head can be a major outcome, historical question, or specific event. Analyses follow the Timeline selection; event search, category, tag, excluded tags, and importance filters apply to Timeline overview.'));
      analysis=analyses.find(item=>item.id===state.analysis)||analyses[0];
      if(!analysis){results.append(node('p','ht-empty','No saved analyses for this timeline. Create one with your own head, branches, and supporting events. Your event connections are still available under Timeline overview.'));return;}
      state.analysis=analysis.id;
      const chooser=node('select','ht-select');chooser.setAttribute('aria-label','Saved fishbone analysis');
      for(const item of analyses){const option=node('option','',item.title);option.value=item.id;chooser.append(option);}chooser.value=analysis.id;
      chooser.addEventListener('change',()=>{state.analysis=chooser.value;update(true,true);});tools.append(chooser);
      if(!readOnly && options.onAnalysisEdit)tools.append(button('Edit analysis','ht-button ht-secondary',()=>options.onAnalysisEdit(analysis,[...state.groups],afterSave)));
    } else results.append(node('p','ht-detail-meta','One fishbone brings the selected timeline’s smaller causal relationships together. Each causal pair has its own category-labelled branch. The cause sits farther out and the effect closer to the spine, joined by a straight arrow. Shared events may appear on more than one branch.'));
    let overview;
    if(!analysis){
      let scoped=filtered;
      let heading=state.groups.length?(state.match==='all'?state.groups.join(' + '):'Filtered connections'):'';
      if(!heading){
        const ids=new Set(filtered.map(event=>event.id));
        const connected=new Set((options.connections||[]).filter(link=>ids.has(link.from)&&ids.has(link.to)&&link.from!==link.to).flatMap(link=>[link.from,link.to]));
        const choices=unique(filtered.filter(event=>connected.has(event.id)).flatMap(event=>event.groups||[])).filter(group=>{
          const members=new Set(filtered.filter(event=>(event.groups||[]).includes(group)).map(event=>event.id));
          return (options.connections||[]).some(link=>members.has(link.from)&&members.has(link.to)&&link.from!==link.to);
        });
        if(choices.length){
          state.overviewGroup=choices.includes(state.overviewGroup)?state.overviewGroup:choices[0];
          const picker=node('select','ht-select');picker.setAttribute('aria-label','Overview timeline');
          for(const group of choices){const option=node('option','',group);option.value=group;picker.append(option);}picker.value=state.overviewGroup;
          picker.addEventListener('change',()=>{state.overviewGroup=picker.value;update(true,true);});tools.append(picker);
          heading=state.overviewGroup;scoped=filtered.filter(event=>(event.groups||[]).includes(heading));
        } else heading='Connected events';
      }
      overview=buildTimelineFishbone(scoped,options.connections||[],heading);
      if(!readOnly && overview&&options.onAnalysisEdit)tools.append(button('Customize this fishbone','ht-button ht-secondary',()=>{
        const names=new Map(scoped.map(event=>[event.id,event.title]));
        const seed={title:heading,causal:true,groups:state.groups.length?[...state.groups]:heading==='Connected events'?[]:[heading],headEventId:'',branches:overview.branches.map(branch=>({title:branch.category,factors:branch.causes.map(cause=>({title:cause.event.title,eventId:cause.event.id,role:'Contributing factor',explanation:overview.links.filter(link=>link.from===cause.event.id).map(link=>link.relation+' → '+names.get(link.to)+(link.explanation?'\n'+link.explanation:'')).join('\n\n'),source:cause.event.source||''}))}))};
        options.onAnalysisEdit(undefined,seed.groups,afterSave,seed);
      }));
    }
    const graph = node('div', 'ht-network-section');
    const detail = node('article','ht-detail-panel');
    const chain = (event,host,path=new Set(),depth=0,budget={left:60}) => {
      // Build a history level only when it is opened. Hidden histories used to
      // repeat whole subgraphs on every selection, even with the panel closed.
      let expanded = false;
      host.addEventListener('toggle', () => {
        if (!host.open || expanded) return;
        expanded = true;
        if(path.has(event.id)){host.append(node('p','ht-detail-meta','Cycle returns to '+event.title));return;}
        const more = () => host.append(node('p','ht-detail-meta','Continue from this event’s details to explore further.'));
        if(depth>=8){more();return;}
        const next=new Set([...path,event.id]);
        for(const link of incomingLinks.get(event.id)||[]){
          if(budget.left<=0){more();break;}
          budget.left--;
          const source=eventsById.get(link.from);
          const branch=node('details','ht-analysis-chain');branch.append(node('summary','', (source?.title||'Unavailable event')+' → '+event.title+' · '+link.relation+(link.disputed?' · disputed':'')));
          if(link.explanation)branch.append(node('p','',link.explanation));if(link.source)branch.append(node('p','ht-detail-source',link.source));
          if(source){branch.append(button('Explore '+source.title,'ht-connection-link',()=>showDetails(source)));chain(source,branch,next,depth+1,budget);}host.append(branch);
        }
      });
    };
    const closeDetails = () => {
      state.graphSelected=''; detail.replaceChildren(); detail.hidden=true;
      options.onStateChange?.(snapshotState(), {navigation:true});
    };
    const showDetails = (item, navigation = true) => {
      detail.replaceChildren();detail.hidden=false;
      state.graphSelected='';
      detail.append(button('Close details','ht-button ht-secondary',closeDetails));
      const event=item.analytical?item.backingEvent:item;
      if(item.analytical){
        detail.append(node('h3','',item.title));
        if(item.factor){
          const factor=item.factor;detail.append(node('p','ht-detail-meta',(factor.role||'Contributing factor')+(factor.disputed?' · disputed':'')));
          if(factor.explanation)detail.append(node('p','ht-analysis-text',factor.explanation));
          if(factor.source)detail.append(node('p','ht-detail-source','Source: '+factor.source));
          if(factor.perspectives){detail.append(node('h4','','Historians’ perspectives'),node('p','ht-analysis-text',factor.perspectives));}
        }
        if(item.attachedId&&!event)detail.append(node('p','ht-detail-meta','The attached event is unavailable or outside this folder. The argument is preserved.'));
        else if(item.timelineHead)detail.append(node('p','ht-detail-meta','The broad topic combining this timeline’s saved causal chains. Customize this fishbone to refine the outcome, branch headings, and explanation.'));
        else if(!event)detail.append(node('p','ht-detail-meta','An analytical '+(item.analysisHead?'outcome or question':'factor')+'; no date or event attachment is required.'));
      }
      if(event){state.graphSelected=event.id;renderDetails(event,detail);const history=node('details','ht-analysis-chain');history.append(node('summary','','Explore earlier causal links (saved relationships)'));chain(event,history);detail.append(history);}
      if(navigation) options.onStateChange?.(snapshotState(), {navigation:true});
    };
    results.append(graph,detail);
    const graphIds = new Set(filtered.map(event => event.id));
    const graphLinks = (options.connections || []).filter(link => graphIds.has(link.from) && graphIds.has(link.to));
    const diagram = analysis ? buildAnalysisFishbone(analysis,allEvents,connections) : overview;
    detail.hidden=true;
    const selected=filtered.find(event=>event.id===state.graphSelected && graphLinks.some(link=>link.from===event.id || link.to===event.id));
    if(analysis&&state.graphSelected){
      const attached=[diagram.outcome,...diagram.branches.flatMap(branch=>branch.causes.map(cause=>cause.event))].find(item=>item.attachedId===state.graphSelected);
      if(attached)showDetails(attached,false);
    }else if(selected)showDetails(selected,false);
    else if(state.graphSelected){const event=filtered.find(item=>item.id===state.graphSelected);if(event)showDetails(event,false);}
    scaleCleanup=mountFishbones(graph,filtered,graphLinks,{dateLabel:item=>item.start?dateRange(item.backingEvent||item):(item.timelineHead?'Timeline overview':(item.kind==='factor'||item.backingEvent?.kind==='factor'?'Abstract factor':'No specific date')),onSelect:showDetails,diagrams:diagram?[diagram]:[],chartZoom:zoomOptions('fishbone')});
  }

  function revealSelected() {
    if(!explicitReveal)return;
    const target=Array.from(root.querySelectorAll?.('[data-event-id]')||[]).find(el=>el.getAttribute('data-event-id')===explicitReveal);
    if(!target)return;
    target.scrollIntoView?.({block:'center',inline:'nearest'});
    if(state.mode==='cards')target.classList.add('ht-recent-event');
    explicitReveal='';
  }
  const requestedReveal=explicitReveal;
  update(false);
  if(!requestedReveal)restoreScroll(initialScroll);
  const exitSearch = event => {
    if (event.key !== 'Escape' || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || doc.activeElement !== search) return false;
    event.preventDefault(); event.stopPropagation();
    const scroll = captureScroll();
    root.focus({preventScroll:true});
    restoreScroll(scroll);
    return true;
  };
  search.addEventListener('keydown', exitSearch);
  const releaseSearchEscape = options.bindSearchEscape?.(search, exitSearch);
  const cleanup = () => {
    disposed = true;
    if (typeof closeReadPreview === 'function') closeReadPreview();
    closeReadPreview = undefined;
    releaseSearchEscape?.(); groupField.dispose(); excludedTagField.dispose(); scaleCleanup(); reorderCleanup();
  };
  // Commands can reveal search without replacing the chart or its selection.
  cleanup.focusSearch = () => {
    const scroll = captureScroll();
    state.collapsed = false;
    syncCollapsed();
    search.focus({preventScroll:true});
    search.select();
    restoreScroll(scroll);
    options.onStateChange?.(snapshotState());
  };
  cleanup.getState = snapshotState;
  return cleanup;
}

function unique(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()))].sort((a, b) => a.localeCompare(b));
}

function dateValue(date) {
  if (Number.isFinite(date.sortValue)) return date.sortValue;
  return Number(date.year) + ((Number(date.month) || 1) - 1) / 12 + ((Number(date.day) || 1) - 1) / 372;
}

function dateLabel(date) {
  if (!date) return '';
  if (date.label) return date.label;
  const year = Number(date.year);
  const parts = [];
  if (date.day) parts.push(String(date.day));
  if (date.month) parts.push(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.month - 1]);
  parts.push(`${Math.abs(year)} ${year < 0 ? 'BCE' : 'CE'}`);
  return `${date.approximate ? 'c. ' : ''}${parts.join(' ')}`;
}

function eventEnd(event) {
  return event.end ? dateUpperBound(event.end) : ['decade', 'century'].includes(event.start.precision) ? dateUpperBound(event.start) : dateValue(event.start);
}

function dateRange(event) {
  if(!event.start)return event.kind==='factor'?'Abstract factor · no date':'Undated';
  return event.end ? `${dateLabel(event.start)} – ${dateLabel(event.end)}` : dateLabel(event.start);
}

function totalRange(events) {
  const first = events[0].start;
  let last = first;
  let latestValue = dateValue(first);
  for (const event of events) {
    const value = eventEnd(event);
    if (value > latestValue) { latestValue = value; last = event.end || event.start; }
  }
  return dateValue(first) === dateValue(last) ? dateLabel(first) : `${dateLabel(first)} — ${dateLabel(last)}`;
}

function colorIndex(text) {
  let hash = 0;
  for (const character of text) hash = ((hash << 5) - hash + character.codePointAt(0)) | 0;
  return Math.abs(hash) % 5;
}

/** Model coordinates are astronomical years with equal-width calendar months. */
function tickLabel(value, span) {
  const astronomical = Math.floor(value + 1e-9);
  const year = astronomical <= 0 ? astronomical - 1 : astronomical;
  const yearText = `${Math.abs(year)} ${year < 0 ? 'BCE' : 'CE'}`;
  if (span >= 4) return yearText;
  const monthValue = Math.max(0, Math.min(11.999999999, (value - astronomical) * 12));
  const month = Math.min(11, Math.floor(monthValue + 1e-9));
  const monthText = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month];
  if (span >= 0.4) return `${monthText} ${yearText}`;
  const leap = astronomical % 4 === 0 && (astronomical % 100 !== 0 || astronomical % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
  const day = Math.min(days, Math.floor((monthValue - month) * days + 1e-7) + 1);
  return `${day} ${monthText} ${yearText}`;
}

/** Pack natural-height boxes outwards from a 44px year-label band. */
function packWallItems(items, gap = 12) {
  const placed = [];
  // Place short periods first so the visible outside-to-inside order is long
  // to short. Use date duration, not the number of displayed year columns.
  const duration = item => item.duration ?? item.last - item.first;
  const ordered = [true, false].flatMap(shared => {
    const group = items.filter(item => Boolean(item.shared) === shared);
    return [...group.filter(item => item.kind === 'points'),
      ...group.filter(item => item.kind !== 'points').sort((a, b) => duration(a) - duration(b))];
  });
  for (const item of ordered) {
    let offset = 22;
    const collisions = placed.filter(other => other.height > 0 && other.side === item.side && item.first <= other.last && item.last >= other.first)
      .sort((a, b) => a.offset - b.offset);
    // A long period must stay outside overlapping shorter periods, even when
    // it could fit into a gap below one raised by a different year's stack.
    if (item.kind !== 'points') for (const other of collisions) {
      if (other.kind !== 'points') offset = Math.max(offset, other.offset + other.height + gap);
    }
    if (item.height > 0) for (const other of collisions) {
      if (offset + item.height + gap <= other.offset) break;
      offset = Math.max(offset, other.offset + other.height + gap);
    }
    placed.push({ ...item, offset });
  }
  return placed;
}

module.exports = { renderTimeline, packWallItems };
