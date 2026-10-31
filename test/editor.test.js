'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real editor event handlers with a minimal DOM and host adapter.
function editor(options = {}) {
  const notices = [], modals = [], calls = [];
  const doc = { createElement(tag) { return new Element(tag); } };
  class Element {
    constructor(tag) { this.style = {}; this.tagName = tag; this.children = []; this.events = {}; this.attrs = {}; this.ownerDocument = doc; this.value = ''; this.textContent = ''; this.classList = { add: name => this.classList.toggle(name,true), contains: name => (this.className || '').split(' ').includes(name), toggle: (name,on) => { const names=new Set((this.className || '').split(' ').filter(Boolean)); if(on)names.add(name);else names.delete(name);this.className=[...names].join(' '); } }; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    remove() { this.parentElement.children=this.parentElement.children.filter(child=>child!==this); }
    setAttribute(name, value) { this.attrs[name] = value; }
    addEventListener(type, callback) { this.listeners??={};(this.listeners[type]??=[]).push(callback);this.events[type]=(...args)=>{let result;for(const listener of this.listeners[type])result=listener(...args);return result;}; }
    removeEventListener(type, callback) { if(this.listeners?.[type])this.listeners[type]=this.listeners[type].filter(listener=>listener!==callback); }
    contains(node) { return this===node||this.children.some(child=>child.contains(node)); }
    focus() { const previous=doc.activeElement;if(previous&&previous!==this){previous.focused=false;previous.events.blur?.({relatedTarget:this});for(let node=previous;node;node=node.parentElement)node.events.focusout?.({relatedTarget:this});}doc.activeElement=this;this.focused=true;this.events.focus?.({relatedTarget:previous});for(let node=this;node;node=node.parentElement)node.events.focusin?.({relatedTarget:previous}); }
    click() { this.events.click?.(); }
    requestSubmit(button) { this.submitter=button;this.submission=this.events.submit({preventDefault(){}}); }
    all() { return [this, ...this.children.flatMap(child => child.all())]; }
  }
  class TFile { constructor(name) { this.path = name + '.md'; this.basename = name; } }
  class Scope {
    constructor(parent) { this.parent=parent;this.handlers=[]; }
    register(modifiers,key,callback) { const handler={modifiers,key,callback};this.handlers.push(handler);return handler; }
    unregister(handler) { this.handlers=this.handlers.filter(item=>item!==handler); }
  }
  class Modal {
    constructor(app) { this.app = app; this.contentEl = new Element('div'); this.scope=new Scope(app.scope); modals.push(this); }
    open() { this.onOpen(); this.contentEl.all().find(node => node.tagName === 'input')?.focus(); }
    close() { this.closed = true; this.onClose(); }
  }
  const obsidian = {
    Plugin: class { constructor(app) { this.app = app; } }, Modal, TFile, Scope, Platform: { isMobile: Boolean(options.mobile) },
    ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, MarkdownRenderChild: class {},
    Notice: class { constructor(text) { notices.push(text); } }, normalizePath: value => value,
  };
  const context = { module: { exports: {} }, require: name => name === 'obsidian' ? obsidian : name === './model' ? require('../src/model') : name === './suggestions' ? require('../src/suggestions') : name === './reading-preferences' ? require('../src/reading-preferences') : {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), context);
  const app = { scope:new Scope(),keymap:{scopes:[],pushScope(scope){this.scopes.push(scope);},popScope(scope){this.scopes=this.scopes.filter(item=>item!==scope);}},metadataCache: { getFileCache: () => ({ frontmatter: { 'timeline-date': '1946', 'timeline-title': 'An existing event', timeline: ['History'] } }) } };
  const plugin = new context.module.exports(app);
  plugin.collect = () => ({ events: [] });
  plugin.settings = { eventFolder: 'History/Events', defaultTimeline: 'History' };
  plugin.saveStandalone = async (...args) => { calls.push({ method: 'timeline', args }); return { id: 'saved' }; };
  plugin.saveEvent = async (...args) => { calls.push({ method: 'note', args }); return new TFile('Saved'); };
  plugin.openTimeline = async () => { calls.push({ method: 'open' }); };
  const current = () => modals.at(-1);
  const nodes = () => current().contentEl.all();
  const form = () => nodes().find(node => node.tagName === 'form');
  const field = label => nodes().find(node => node.tagName === 'label' && node.children[0].textContent === label).children[1];
  const enter = () => { field('Event title').value = 'A new event'; field('Start date').value = '221 BCE'; };
  const submit = () => form().events.submit({ preventDefault() {} });
  return { plugin, current, nodes, field, enter, submit, calls, notices, TFile, modals, doc, app };
}

test('Add event defaults to timeline storage and stays in the timeline after saving', async () => {
  const e = editor(); e.plugin.editEvent(); e.enter();
  assert.equal(e.field('Save event as').value, 'timeline');
  assert.equal(e.field('Timelines (one name per line)').value, '');
  await e.submit();
  assert.deepEqual(e.calls.map(call => call.method), ['timeline', 'open']);
  assert.equal(e.calls[0].args[0]['timeline-date'], '221 BCE');
  assert.equal(e.current().closed, true);
});

test('new events inherit all selected timelines while existing event assignments stay intact',async()=>{
 for(const selected of [['Japan','World History'],'Japan',[]]){
  const e=editor();e.plugin.editEvent(undefined,selected);e.enter();
  const expected=Array.isArray(selected)?selected:[selected];
  assert.equal(e.field('Timelines (one name per line)').value,expected.join('\n'));
  await e.submit();assert.deepEqual(Array.from(e.calls[0].args[0].timeline),expected);
 }
 const e=editor();e.plugin.editEvent(new e.TFile('Existing'),['Japan','World History']);
 assert.equal(e.field('Timelines (one name per line)').value,'History');
 await e.submit();assert.deepEqual(Array.from(e.calls[0].args[0].timeline),['History']);
});

test('separate previous-input buttons change only their own field without moving the editor',async()=>{
 for(const storage of ['timeline','note']){
  const e=editor();e.plugin.previousEventInput={timelines:['Japan','World History'],category:'Politics',tags:['war','diplomacy']};
  e.plugin.collect=()=>({events:[{groups:['Japan','World History','Russia'],category:'Politics',tags:['war','diplomacy']}]});
  e.plugin.editEvent();e.enter();e.field('Save event as').value=storage;
  e.field('Summary').value='Keep my summary';e.field('Source / citation').value='Keep my source';
  const timelines=e.field('Timelines (one name per line)');timelines.value='Russia';timelines.events.input();
  const modal=e.current();modal.contentEl.scrollTop=420;
  assert.equal(e.nodes().find(n=>n.attrs['aria-label']==='Previous timelines').textContent,'Japan · World History');
  assert.equal(e.nodes().find(n=>n.attrs['aria-label']==='Previous category').textContent,'Politics');
  assert.equal(e.nodes().find(n=>n.attrs['aria-label']==='Previous tags').textContent,'war, diplomacy');
  const category=e.field('Category'),tags=e.field('Tags (comma or space separated)');category.value='Economics';tags.value='trade';
  const button=e.nodes().find(n=>n.textContent==='Use previous timelines');assert.equal(button.disabled,false);assert.equal(button.parentElement.parentElement,timelines.parentElement);button.click();
  assert.equal(category.value,'Economics');assert.equal(tags.value,'trade');
  const categoryButton=e.nodes().find(n=>n.textContent==='Use previous category');assert.equal(categoryButton.parentElement.parentElement,category.parentElement);categoryButton.click();
  assert.equal(tags.value,'trade');assert.equal(timelines.value,'Japan\nWorld History');
  const tagsButton=e.nodes().find(n=>n.textContent==='Use previous tags');assert.equal(tagsButton.parentElement.parentElement,tags.parentElement);tagsButton.click();
  assert.equal(timelines.value,'Japan\nWorld History');assert.equal(e.field('Category').value,'Politics');assert.equal(e.field('Tags (comma or space separated)').value,'war, diplomacy');
  assert.equal(modal.contentEl.scrollTop,420);assert.equal(e.field('Event title').value,'A new event');assert.equal(e.field('Start date').value,'221 BCE');assert.equal(e.field('Summary').value,'Keep my summary');assert.equal(e.field('Source / citation').value,'Keep my source');
  const picker=e.nodes().find(n=>n.attrs['aria-label']==='Choose existing timeline');assert.deepEqual(picker.children.map(n=>n.value),['','Russia']);
  assert.equal(timelines.parentElement.children.find(n=>n.className==='ht-type-suggestions').hidden,true);
  button.click();assert.equal(timelines.value,'Japan\nWorld History');
  await e.submit();assert.deepEqual(Array.from(e.calls[0].args[0].timeline),['Japan','World History']);
 }
});

test('previous inputs are optional, support empty values, and do not change when a form is cancelled',()=>{
 const e=editor();e.plugin.editEvent();for(const label of ['timelines','category','tags'])assert.equal(e.nodes().find(n=>n.textContent==='Use previous '+label).disabled,true);
 e.current().close();e.plugin.previousEventInput={timelines:[],category:'',tags:[]};e.plugin.editEvent();
 for(const label of ['timelines','category','tags'])assert.equal(e.nodes().find(n=>n.attrs['aria-label']==='Previous '+label).textContent,'(empty)');
 e.field('Category').value='Politics';e.field('Tags (comma or space separated)').value='war';e.field('Timelines (one name per line)').value='Japan';
 for(const label of ['timelines','category','tags'])e.nodes().find(n=>n.textContent==='Use previous '+label).click();
 for(const label of ['Category','Tags (comma or space separated)','Timelines (one name per line)'])assert.equal(e.field(label).value,'');
 e.field('Category').value='Changed';e.nodes().find(n=>n.textContent==='Cancel').click();assert.equal(e.plugin.previousEventInput.category,'');
});

test('Mod+Enter uses the event modal save path for new and existing events and unregisters on close',async()=>{
 for(const kind of ['new','new note','existing','existing note']){
  const e=editor();
  if(kind==='existing'){
   e.plugin.standaloneEvents=[{id:'one',properties:{'timeline-title':'Stored','timeline-date':'1900',timeline:['History']}}];
   e.plugin.openEvent({storage:'timeline',standaloneId:'one'});
  }else e.plugin.editEvent(kind==='existing note'?new e.TFile('Existing'):undefined);
  if(kind.startsWith('new')){e.enter();if(kind==='new note')e.field('Save event as').value='note';}
  const modal=e.current(),form=e.nodes().find(n=>n.tagName==='form'),handler=modal.scope.handlers[0];
  assert.equal(modal.scope.handlers.length,1);assert.equal(handler.modifiers.join(','),'Mod');assert.equal(handler.key,'Enter');
  e.field('Summary').focus();let prevented=false,stopped=false;
  assert.equal(handler.callback({preventDefault(){prevented=true;},stopPropagation(){stopped=true;}}),false);
  await form.submission;
  assert.equal(prevented,true);assert.equal(stopped,true);assert.equal(modal.closed,true);assert.equal(modal.scope.handlers.length,0);
  assert.equal(e.calls[0].method,kind.endsWith('note')?'note':'timeline');assert.equal(form.submitter.type,'submit');
 }
});

test('event save hotkey respects validation, composition, repeat, in-flight writes and cancel cleanup',async()=>{
 const e=editor();e.plugin.editEvent();const modal=e.current(),form=e.nodes().find(n=>n.tagName==='form'),handler=modal.scope.handlers[0];
 const press=extra=>handler.callback({preventDefault(){},stopPropagation(){},...extra});
 press({isComposing:true});press({repeat:true});assert.equal(form.submission,undefined);
 press();await form.submission;assert.equal(e.calls.length,0);assert.equal(modal.closed,undefined);assert.match(e.nodes().find(n=>n.attrs.role==='alert').textContent,/title/);
 e.enter();e.field('Start date').value='0';press();await form.submission;assert.equal(e.calls.length,0);
 e.field('Start date').value='1900';let writes=0,release;
 e.plugin.saveStandalone=()=>{writes++;return new Promise(resolve=>release=resolve);};
 press();press();assert.equal(writes,1);release({id:'saved'});await form.submission;assert.equal(modal.scope.handlers.length,0);
 e.plugin.editEvent();const cancelled=e.current();e.nodes().find(n=>n.textContent==='Cancel').click();assert.equal(cancelled.scope.handlers.length,0);
});

test('modified Enter is not consumed by autocomplete and plain Enter still chooses a suggestion',()=>{
 const e=editor();e.plugin.collect=()=>({events:[{groups:['Russia'],tags:[]}]});e.plugin.editEvent();
 const input=e.field('Timelines (one name per line)');input.value='Ru';input.events.input();
 for(const modifier of ['metaKey','ctrlKey','altKey','shiftKey']){
  let consumed=false;input.events.keydown({key:'Enter',[modifier]:true,preventDefault(){consumed=true;},stopPropagation(){}});
  assert.equal(consumed,false);assert.equal(input.value,'Ru');
 }
 input.events.keydown({key:'Enter',preventDefault(){},stopPropagation(){}});assert.equal(input.value,'Russia');
});

test('choosing Create a Markdown note routes through note creation', async () => {
  const e = editor(); e.plugin.editEvent(); e.enter();
  e.field('Save event as').value = 'note';
  await e.submit();
  assert.deepEqual(e.calls.map(call => call.method), ['note', 'open']);
  assert.equal(e.calls[0].args[1], undefined);
  assert.equal(e.current().closed, true);
});

test('editing a timeline-only event keeps its ID and does not create a note', async () => {
  const e = editor();
  const record = { id: 'one', folder: 'History/Events', properties: { 'timeline-title': 'Stored event', 'timeline-date': '1911', timeline: ['History'] } };
  e.plugin.standaloneEvents = [record];
  e.plugin.openEvent({ storage: 'timeline', standaloneId: record.id });
  assert.equal(e.nodes().some(node => node.attrs['aria-label'] === 'Save event as'), false);
  e.field('Event title').value = 'Updated event';
  await e.submit();
  assert.deepEqual(e.calls.map(call => call.method), ['timeline']);
  assert.equal(e.calls[0].args[1], record.id);
  assert.equal(e.calls[0].args[2], JSON.stringify(record));
});

test('editing a linked note keeps using the existing note', async () => {
  const e = editor(), note = new e.TFile('Existing');
  e.plugin.editEvent(note);
  assert.equal(e.nodes().some(node => node.attrs['aria-label'] === 'Save event as'), false);
  await e.submit();
  assert.deepEqual(e.calls.map(call => call.method), ['note']);
  assert.equal(e.calls[0].args[1], note);
});

test('failed persistence leaves the editor open with entered text and an error', async () => {
  const e = editor(); e.plugin.editEvent(); e.enter();
  e.plugin.saveStandalone = async () => { throw new Error('Disk is full'); };
  await e.submit();
  assert.equal(e.current().closed, undefined);
  assert.equal(e.field('Event title').value, 'A new event');
  assert.equal(e.nodes().find(node => node.attrs.role === 'alert').textContent, 'Disk is full');
  assert.equal(e.nodes().find(node => node.type === 'submit').disabled, false);
  assert.equal(e.calls.length, 0);
});

test('invalid editor dates never invoke either storage route', async () => {
  const e = editor(); e.plugin.editEvent(); e.enter();
  e.field('Start date').value = '0';
  await e.submit();
  assert.equal(e.calls.length, 0);
  assert.match(e.nodes().find(node => node.attrs.role === 'alert').textContent, /year 0/);
});

test('editor normalizes tags before passing them to either storage route', async () => {
 for (const choice of ['timeline','note']) {
  const e=editor();e.plugin.editEvent();e.enter();e.field('Save event as').value=choice;
  e.field('Tags (comma or space separated)').value='#War, war 外交';
  await e.submit();assert.deepEqual(Array.from(e.calls[0].args[0]['timeline-tags']),['war','外交']);
 }
});


test('time type detects decades, validates periods and clears an end when switched to specific', async () => {
 const e=editor(); e.plugin.editEvent(); e.enter();
 const type=e.field('Time type'),end=e.field('End date');
 e.field('Start date').value='1920s'; await e.submit();
 assert.equal(type.value,'period');assert.equal(end.disabled,false);
 assert.equal(e.calls[0].args[0]['timeline-date'],'1920s');
 const p=editor(); p.plugin.editEvent(); p.enter(); p.field('Time type').value='period';
 await p.submit(); assert.equal(p.calls.length,0);
 p.field('End date').value='200 BCE'; await p.submit(); assert.equal(p.calls[0].args[0]['timeline-end'],'200 BCE');
 const q=editor(); q.plugin.editEvent(); q.enter(); q.field('End date').value='200 BCE';
 await q.submit(); assert.equal(q.calls[0].args[0]['timeline-end'],undefined);
});


test('saved values can be selected and multi-value fields append without duplicates', async () => {
 const e=editor();
 e.plugin.collect=()=>({events:[{groups:['History','China'],tags:['war'],category:'Politics',location:'Beijing',source:'Book A'},{groups:['China'],tags:['war'],category:'Politics'}]});
 e.plugin.editEvent(); e.enter();
 const pick=(name,value)=>{const node=e.nodes().find(n=>n.attrs['aria-label']===`Choose existing ${name}`);node.value=value;node.events.change();return node;};
 const groups=pick('timeline','China');pick('timeline','China');
 assert.equal(groups.children.length,2);
 assert.equal(e.field('Timelines (one name per line)').value,'China');
 e.field('Tags (comma or space separated)').value='diplomacy';pick('tag','war');pick('tag','war');
 assert.equal(e.field('Tags (comma or space separated)').value,'diplomacy, war');
 pick('category','Politics');pick('location','Beijing');pick('source','Book A');
 await e.submit();
 assert.equal(e.calls[0].args[0]['timeline-location'],'Beijing');
 assert.equal(e.calls[0].args[0]['timeline-source'],'Book A');
});


test('typing offers matching sources and completes only the active timeline or tag token', () => {
 const e=editor(); e.plugin.collect=()=>({events:[{groups:['China'],tags:['war'],source:'Book of History',category:'Politics'}]});
 e.plugin.editEvent();
 const complete=(field,text,choice)=>{
  const input=e.field(field);input.value=text;input.events.input();
  const item=e.nodes().find(n=>n.classList.contains('ht-type-suggestion') && n.textContent===choice);
  assert.ok(item);item.events.click();return input.value;
 };
 assert.equal(complete('Source / citation','book','Book of History'),'Book of History');
 assert.equal(complete('Timelines (one name per line)','World\nChi','China'),'World\nChina');
 assert.equal(complete('Tags (comma or space separated)','diplomacy, wa','war'),'diplomacy, war');
});

test('reusable suggestions match the start of the current token, not interior letters',()=>{
 const e=editor();e.plugin.collect=()=>({events:[{groups:['Russia','U.S.'],tags:['russia','usa'],category:'Russia',location:'Russia',source:'Russia'},{groups:[],tags:[],category:'U.S.',location:'U.S.',source:'U.S.'}]});e.plugin.editEvent();
 for(const [label,value,expected] of [['Timelines (one name per line)','China\nu','U.S.'],['Tags (comma or space separated)','war, u','usa'],['Category','u','U.S.'],['Location','u','U.S.'],['Source / citation','u','U.S.']]){
  const input=e.field(label);input.value=value;input.events.input();
  const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');
  assert.deepEqual(box.children.map(n=>n.textContent),[expected]);
  input.events.keydown({key:'Enter',preventDefault(){}});assert.ok(input.value.endsWith(expected));
  input.events.input();assert.equal(box.children[0].textContent,expected);
 }
});

test('connection suggestions match title prefixes and do not match date or kind labels',()=>{
 const e=editor();e.plugin.collect=()=>({events:[{id:'result',title:'Result'},{id:'r',title:'Russia',start:{label:'1900 CE'}},{id:'u',title:'U.S.',kind:'factor'}]});e.plugin.editConnection({id:'result'},undefined,'incoming');
 const input=e.field('Cause / contributing event');const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');
 input.value='u';input.events.input();assert.equal(box.children[0].textContent,'U.S. · Abstract factor');assert.equal(box.children.some(n=>n.textContent.startsWith('Russia')),false);
 for(const query of ['1900','abstract']){input.value=query;input.events.input();assert.ok(box.children.every(n=>n.textContent.startsWith('Create ')));}
 input.value='russ';input.events.input();assert.equal(box.children[0].textContent,'Russia · 1900 CE');
});

test('arrow keys return from suggestions to typing and importance is saved',async()=>{
 const e=editor();e.plugin.collect=()=>({events:[{groups:['China'],tags:[]}]});e.plugin.editEvent();e.enter();
 const input=e.field('Timelines (one name per line)');input.value='Chi';input.events.input();
 const suggestion=e.nodes().find(n=>n.classList.contains('ht-type-suggestion'));
 input.events.keydown({key:'ArrowDown',preventDefault(){}});assert.equal(suggestion.focused,true);
 input.focused=false;suggestion.events.keydown({key:'ArrowUp',preventDefault(){}});assert.equal(input.focused,true);
 e.nodes().find(n=>n.attrs['aria-label']==='Highlight as important').checked=true;
 await e.submit();assert.equal(e.calls[0].args[0]['timeline-important'],true);
});

test('connection editor searches choices and saves directed relationship evidence',async()=>{
 const e=editor();e.plugin.collect=()=>({events:[{id:'a',title:'A',start:{label:'1900 CE'}},{id:'b',title:'B',start:{label:'1901 CE'}}]});
 let saved;e.plugin.saveConnection=async draft=>{saved=draft;};e.plugin.editConnection({id:'a'});
 e.field('Effect / related event');
 const to=e.nodes().find(n=>n.attrs['aria-label']==='Effect / related event');to.value='B';to.events.input();
 const suggestion=e.nodes().find(n=>n.textContent==='B · 1901 CE');suggestion.events.click();
 e.field('Relationship').value='prompted';e.field('Explanation').value='Evidence';
 await e.submit();assert.equal(saved.from,'a');assert.equal(saved.to,'b');assert.equal(saved.relation,'prompted');assert.equal(saved.explanation,'Evidence');
 assert.equal(e.current().closed,true);
});

test('exact suggestions remain and Enter completes without submitting',()=>{
 const e=editor();e.plugin.collect=()=>({events:[{groups:['World History'],tags:[],category:'Politics'}]});e.plugin.editEvent();
 const input=e.field('Category');input.value='politics';input.events.input();
 assert.ok(e.nodes().some(n=>n.textContent==='Politics' && n.tagName==='button'));
 let prevented=false;input.events.keydown({key:'Enter',preventDefault(){prevented=true;}});
 assert.equal(input.value,'Politics');assert.equal(prevented,true);assert.equal(e.calls.length,0);
});

test('suggestion navigation removes the first highlight and keeps only the focused item active',()=>{
 for(const label of ['Timelines (one name per line)','Tags (comma or space separated)']){
  const e=editor();e.plugin.collect=()=>({events:[{groups:['Russia','U.S.','World History'],tags:['as','diplomacy',"power'struggle",'war']}]});e.plugin.editEvent();
  const input=e.field(label);input.value='';input.focus();
  const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');
  const highlighted=()=>box.children.filter(n=>n.classList.contains('ht-suggestion-active'));
  const key=(element,key)=>element.events.keydown({key,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(highlighted(),[box.children[0]]);
  key(input,'ArrowDown');key(box.children[0],'ArrowDown');
  assert.equal(input.ownerDocument.activeElement,box.children[1]);
  assert.deepEqual(highlighted(),[box.children[1]]);
  box.children[0].events.mouseenter();assert.deepEqual(highlighted(),[box.children[1]]);
  key(box.children[1],'ArrowDown');assert.deepEqual(highlighted(),[box.children[2]]);
  key(box.children[2],'ArrowUp');assert.deepEqual(highlighted(),[box.children[1]]);
  key(box.children[1],'ArrowLeft');assert.equal(input.ownerDocument.activeElement,input);assert.equal(highlighted().length,1);
  box.children[1].events.mouseenter();assert.deepEqual(highlighted(),[box.children[1]]);
  const chosen=box.children[1].textContent;key(input,'Enter');assert.equal(input.value,chosen);assert.equal(box.hidden,true);assert.equal(e.calls.length,0);
 }
});

test('every autocomplete in event, historian, connection and analysis editors has one active row',()=>{
 const covered=[];
 for(const kind of ['event','connection','analysis']){
  const e=editor();const names=['Russia','U.S.','World History'];
  const events=names.map((title,i)=>({id:String(i),title,groups:[title],tags:[title.toLowerCase()],category:title,location:title,source:title,perspectives:[{historian:title,source:title}]}));
  e.plugin.collect=()=>({events});e.plugin.connections=names.map(source=>({source,relation:source}));
  e.plugin.analyses=names.map(title=>({branches:[{title,factors:[{source:title}]}]}));
  if(kind==='event'){e.plugin.editEvent();e.nodes().find(n=>n.textContent==='Add historian perspective').click();}
  if(kind==='connection')e.plugin.editConnection(events[0]);
  if(kind==='analysis'){e.plugin.editAnalysis();e.nodes().find(n=>n.textContent==='Add branch').click();e.nodes().find(n=>n.textContent==='Add factor').click();}
  const inputs=e.nodes().filter(n=>['input','textarea'].includes(n.tagName)&&typeof n.events.input==='function'&&n.parentElement.children.some(child=>child.className==='ht-type-suggestions'));
  for(const input of inputs){
   const label=input.parentElement.children[0].textContent;covered.push(kind+': '+label);
   input.value='';input.events.input();input.focus();
   const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');
   const active=()=>box.children.filter(n=>n.classList.contains('ht-suggestion-active'));
   assert.ok(box.children.length>=2,kind+': '+label);
   const key=(el,key)=>el.events.keydown({key,preventDefault(){},stopPropagation(){}});
   key(input,'ArrowDown');key(box.children[0],'ArrowDown');
   assert.deepEqual(active(),[box.children[1]],kind+': '+label);
   box.children[0].events.mouseenter();assert.deepEqual(active(),[box.children[1]]);
   key(box.children[1],'ArrowUp');assert.deepEqual(active(),[box.children[0]]);
   key(box.children[0],'ArrowRight');assert.equal(input.ownerDocument.activeElement,input);
   box.children[1].events.mouseenter();assert.deepEqual(active(),[box.children[1]]);
   const selected=box.children[1].textContent.split(' · ')[0];key(input,'Enter');
   assert.equal(input.value,label==='Find an event for this branch'?'':selected);assert.equal(box.hidden,true);
  }
 }
 assert.equal(covered.length,18);
});
test('new event form saves unknown dates and offers duplicate event editing',async()=>{
 const e=editor();let opened;e.plugin.editFromEvent=event=>{opened=event;};e.plugin.collect=()=>({events:[{id:'old',title:'Existing',groups:[],tags:[]}]});e.plugin.editEvent();e.enter();
 e.field('Event title').value='EXISTING';e.field('Event title').events.input();assert.ok(e.nodes().some(n=>n.textContent==='Edit: Existing'));
 e.field('Event title').value='New event';e.field('Time type').value='undated';e.field('Time type').events.change();
 await e.submit();assert.equal(e.calls[0].args[0]['timeline-undated'],true);assert.equal(e.calls[0].args[0]['timeline-date'],undefined);
});
test('adding a cause preselects current event as effect and allows quick creation with Enter',async()=>{
 const e=editor();e.plugin.collect=()=>({events:[{id:'result',title:'Result',start:{label:'1900'}}]});let draft;e.plugin.saveConnection=async value=>{draft=value;};e.plugin.editConnection({id:'result',groups:['History']},undefined,'incoming');
 const source=e.nodes().find(n=>n.attrs['aria-label']==='Cause / contributing event');source.value='New cause';source.events.input();source.events.keydown({key:'Enter',preventDefault(){}});
 await e.submit();assert.equal(draft.to,'result');assert.equal(draft.fromNew.title,'New cause');assert.equal(draft.fromNew.date,'');
});

test('multiple historians perspectives save independently with their citations',async()=>{
 const e=editor();e.plugin.editEvent();e.enter();
 const add=e.nodes().find(n=>n.textContent==='Add historian perspective');add.click();add.click();
 const cards=e.nodes().filter(n=>n.className==='ht-perspective-card');
 cards.forEach((card,index)=>{const fields=card.all().filter(n=>['input','textarea'].includes(n.tagName));fields[0].value='Historian '+index;fields[1].value='Interpretation '+index;fields[2].value='Source '+index;});
 await e.submit();const rows=e.calls[0].args[0]['timeline-perspectives'];assert.equal(rows.length,2);assert.equal(rows[1].historian,'Historian 1');assert.equal(rows[0].source,'Source 0');
});

test('connection suggestions open immediately and prefer a full match over longer names',async()=>{
 const e=editor();const events=[{id:'result',title:'Result',start:{label:'1950'}},...Array.from({length:12},(_,i)=>({id:'long'+i,title:'Politics '+i,start:{label:'1900'}})),{id:'exact',title:'Politics',start:null}];
 e.plugin.collect=()=>({events});let saved;e.plugin.saveConnection=async draft=>{saved=draft;};
 e.plugin.editConnection({id:'result'},undefined,'incoming');
 const input=e.field('Cause / contributing event');assert.equal(input.focused,true);
 let box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');assert.equal(box.hidden,false);
 assert.equal(box.children.some(n=>n.textContent.startsWith('Result ·')),false);
 input.value='politics';input.events.input();assert.equal(box.children[0].textContent,'Politics · Undated');
 input.events.keydown({key:'Enter',preventDefault(){}});await e.submit();assert.equal(saved.from,'exact');assert.equal(saved.to,'result');
});
test('connection create action remains visible when many existing names match',()=>{
 const e=editor();e.plugin.collect=()=>({events:[{id:'current',title:'Result'},...Array.from({length:12},(_,i)=>({id:'event'+i,title:'Political change '+i}))]});
 e.plugin.editConnection({id:'current'},undefined,'incoming');const input=e.field('Cause / contributing event');input.value='Political';input.events.input();
 const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');assert.equal(box.children.length,10);assert.equal(box.children.at(-2).textContent,'Create new event: Political');assert.equal(box.children.at(-1).textContent,'Create abstract factor: Political');
});
test('connection case toggle updates visible matches and rolls back on failed persistence',async()=>{
 const e=editor();e.plugin.collect=()=>({events:[{id:'result',title:'Result'},{id:'cause',title:'Politics'}]});let fail=false;
 e.plugin.saveIgnoreCase=async()=>{if(fail)throw new Error('Unable to save preference');};e.plugin.editConnection({id:'result'},undefined,'incoming');
 const input=e.field('Cause / contributing event');input.value='politics';input.events.input();
 const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');const toggle=e.nodes().find(n=>n.tagName==='input'&&n.type==='checkbox');
 toggle.checked=false;await toggle.events.change();assert.equal(box.children.length,0);
 toggle.checked=true;await toggle.events.change();assert.equal(box.children[0].textContent,'Politics · Undated');toggle.checked=false;await toggle.events.change();fail=true;toggle.checked=true;await toggle.events.change();assert.equal(toggle.checked,false);assert.equal(toggle.disabled,false);assert.equal(e.notices.at(-1),'Unable to save preference');
});
test('case-insensitive duplicate event suggestion redirects to the existing editor',()=>{
 const e=editor(),old={id:'known',title:'Existing event',groups:[],tags:[]};let edited;
 e.plugin.collect=()=>({events:[old]});e.plugin.editFromEvent=event=>{edited=event;};e.plugin.editEvent();const modal=e.current();
 e.field('Event title').value='EXISTING EVENT';e.field('Event title').events.input();e.nodes().find(n=>n.textContent==='Edit: Existing event').click();assert.equal(modal.closed,true);assert.equal(edited,old);assert.equal(e.calls.length,0);
});

test('citations entered in connections or historian perspectives can be reused in the event editor',()=>{
 const e=editor();e.plugin.connections=[{source:'Connection source'}];e.plugin.collect=()=>({events:[{id:'a',title:'A',groups:[],tags:[],perspectives:[{historian:'Historian A',source:'Perspective source'}]}]});e.plugin.editEvent();
 const source=e.field('Source / citation');source.value='connection source';source.events.input();source.events.keydown({key:'Enter',preventDefault(){}});assert.equal(source.value,'Connection source');
 e.nodes().find(n=>n.textContent==='Add historian perspective').click();const card=e.nodes().find(n=>n.className==='ht-perspective-card');const fields=card.all().filter(n=>['input','textarea'].includes(n.tagName));
 fields[0].value='historian a';fields[0].events.input();fields[0].events.keydown({key:'Enter',preventDefault(){}});assert.equal(fields[0].value,'Historian A');
 fields[2].value='perspective source';fields[2].events.input();fields[2].events.keydown({key:'Enter',preventDefault(){}});assert.equal(fields[2].value,'Perspective source');
});

test('analysis editor supports a broad head, custom branches, exact-match event evidence, and cancellation',async()=>{
 const e=editor();let saved;const event={id:'a',title:'Portsmouth',groups:['Japan'],start:{label:'1905'}};
 e.plugin.collect=()=>({events:[event]});e.plugin.saveAnalysis=async draft=>{saved=draft;return {...draft,id:'analysis'};};e.plugin.editAnalysis(undefined,'Japan');
 const input=(label,value)=>{const field=e.field(label);field.value=value;field.events.input();return field;};
 input('Outcome / question at the head','Why expansion?');e.nodes().find(n=>n.textContent==='Add branch').click();input('Branch heading','Long-term conditions');e.nodes().find(n=>n.textContent==='Add factor').click();input('Factor / argument','A stronger regional position');
 const picker=input('Supporting event (optional)','portsmouth');assert.ok(e.nodes().some(n=>n.textContent==='Portsmouth · 1905'));picker.events.keydown({key:'Enter',preventDefault(){}});
 input('How it contributed','A mechanism to assess');await e.submit();assert.equal(saved.branches[0].factors[0].eventId,'a');assert.equal(saved.title,'Why expansion?');assert.equal(saved.groups[0],'Japan');assert.equal(e.current().closed,true);
 saved=undefined;e.plugin.editAnalysis();e.nodes().find(n=>n.textContent==='Cancel').click();assert.equal(saved,undefined);
});

test('new analyses inherit multiple timelines without changing saved or seeded assignments',async()=>{
 const e=editor();let saved;
 e.plugin.saveAnalysis=async draft=>{saved=draft;return {...draft,id:'analysis'};};
 const selected=['Japan','World History'];e.plugin.editAnalysis(undefined,selected);
 selected.push('China');
 assert.equal(e.field('Timelines (one name per line)').value,'Japan\nWorld History');
 const title=e.field('Outcome / question at the head');title.value='Why expansion?';title.events.input();
 await e.submit();assert.deepEqual(Array.from(saved.groups),['Japan','World History']);
 const previous={id:'existing',title:'Existing analysis',groups:[],branches:[]};
 e.plugin.editAnalysis(previous,['Japan','World History']);
 assert.equal(e.field('Timelines (one name per line)').value,'');
 await e.submit();assert.deepEqual(Array.from(saved.groups),[]);assert.deepEqual(previous.groups,[]);
 const seed={title:'Seeded analysis',groups:['Russia'],branches:[]};
 e.plugin.editAnalysis(undefined,['Japan','World History'],undefined,seed);
 assert.equal(e.field('Timelines (one name per line)').value,'Russia');
 await e.submit();assert.deepEqual(Array.from(saved.groups),['Russia']);assert.deepEqual(seed.groups,['Russia']);
});

test('Add event appends several linked factors to the chosen branch and preserves the causal chain after saving',async()=>{
 const e=editor();let saved;
 const events=[
  {id:'mukden',title:'Mukden Incident',groups:['Japan'],start:{label:'1931'}},
  {id:'lytton',title:'Lytton Report',groups:['World History'],start:{label:'1932'}},
  {id:'league',title:'Japan leaves the League',groups:['World History'],start:{label:'1933'}}
 ];
 const previous={id:'a',title:'Expansion',groups:['Japan'],causal:true,branches:[
  {title:'Other branch',factors:[{title:'Existing interpretation',eventId:'lytton',source:'Keep this citation'}]},
  {title:'Diplomacy',factors:[{title:'Mukden Incident',eventId:'mukden',role:'Trigger'}]}
 ]};
 const original=JSON.stringify(previous);
 e.plugin.collect=()=>({events});e.plugin.saveAnalysis=async draft=>{saved=JSON.parse(JSON.stringify(draft));return saved;};e.plugin.editAnalysis(previous);
 const branches=e.nodes().filter(n=>n.classList.contains('ht-analysis-branch-editor'));
 const originalFactor=e.nodes().find(n=>n.classList.contains('ht-analysis-factor-editor'));
 const originalTitle=e.field('Factor / argument');
 originalTitle.value='Revised interpretation';originalTitle.events.input();branches[0].open=false;branches[1].open=true;e.current().contentEl.scrollTop=620;
 const add=branches[1].all().find(n=>n.textContent==='Add event');add.click();
 const input=branches[1].all().find(n=>n.attrs['aria-label']==='Find an event for this branch');
 const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');
 assert.equal(e.doc.activeElement,input);
 for(const title of ['Lytton Report','Japan leaves the League']){
  input.value=title;input.events.input();assert.equal(box.children.length,1);
  input.events.keydown({key:'Enter',preventDefault(){},stopPropagation(){}});
  assert.equal(input.value,'');assert.equal(e.doc.activeElement,input);assert.equal(e.current().contentEl.scrollTop,620);
 }
 assert.equal(branches[1].all().find(n=>n.classList.contains('ht-analysis-count')).textContent,'3 factors');
 assert.equal(e.nodes().find(n=>n.classList.contains('ht-analysis-factor-editor')),originalFactor);
 assert.equal(e.field('Factor / argument'),originalTitle);assert.equal(branches[0].open,false);
 assert.equal(JSON.stringify(previous),original);assert.equal(saved,undefined);assert.equal(e.calls.length,0);
 await e.submit();
 assert.deepEqual(saved.branches[1].factors,[
  {title:'Mukden Incident',eventId:'mukden',role:'Trigger'},
  {title:'Lytton Report',eventId:'lytton',role:'Contributing factor'},
  {title:'Japan leaves the League',eventId:'league',role:'Contributing factor'}
 ]);
 assert.equal(saved.branches[0].factors[0].title,'Revised interpretation');assert.equal(saved.branches[0].factors[0].source,'Keep this citation');
 e.plugin.editAnalysis(saved);
 const reopened=e.nodes().filter(n=>n.classList.contains('ht-analysis-branch-editor'))[1];
 assert.deepEqual(reopened.all().filter(n=>n.classList.contains('ht-analysis-factor-summary')).map(n=>n.textContent),events.map(event=>event.title));
 const {buildAnalysisFishbone}=require('../src/graph');
 const diagram=buildAnalysisFishbone(saved,events,[{from:'mukden',to:'lytton',relation:'led to'},{from:'lytton',to:'league',relation:'prompted'}]);
 assert.equal(diagram.branches.length,2);
 assert.deepEqual(diagram.branches[1].causes.map(cause=>cause.event.attachedId),['mukden','lytton','league']);
 assert.equal(diagram.branches[1].links.length,2);
});

test('branch Add event searches aliases and typos across timelines and excludes duplicates by event ID',async()=>{
 const e=editor();let saved;
 const events=[
  {id:'existing',title:'Treaty',groups:['Japan'],start:{label:'1905'}},
  {id:'outcome',title:'Branch outcome',groups:['Japan'],start:{label:'1939'}},
  {id:'distinct',title:'Treaty',aliases:['Settlement agreement'],groups:['Europe'],start:{label:'1919'}},
  {id:'stresa',title:'Stresa Front',groups:['Europe'],start:{label:'1935'}},
  {id:'abstract',title:'Nationalism',kind:'factor',groups:['Europe']}
 ];
 e.plugin.collect=()=>({events});e.plugin.saveAnalysis=async draft=>{saved=JSON.parse(JSON.stringify(draft));return saved;};
 e.plugin.editAnalysis({id:'a',title:'Japan',groups:['Japan'],branches:[{title:'Politics',eventId:'outcome',factors:[{title:'Existing treaty interpretation',eventId:'existing'}]}]});
 e.nodes().find(n=>n.textContent==='Add event').click();
 const input=e.field('Find an event for this branch'),box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');
 const search=query=>{input.value=query;input.events.input();return box.children.map(n=>n.textContent);};
 assert.deepEqual(search('Branch outcome'),[]);
 assert.deepEqual(search('Treaty'),['Treaty · 1919']);
 assert.deepEqual(search('Settlement'),['Treaty · 1919']);box.children[0].click();
 assert.deepEqual(search('Treaty'),[]);assert.deepEqual(search('Settlement'),[]);
 assert.deepEqual(search('Stresa'),['Stresa Front · 1935']);
 assert.deepEqual(search('Streza'),['Stresa Front · 1935']);box.children[0].click();
 const abstract=search('Nationalism');assert.equal(abstract.length,1);assert.match(abstract[0],/^Nationalism · /);box.children[0].click();
 assert.deepEqual(search('An event that does not exist'),[]);assert.equal(e.calls.length,0);
 await e.submit();assert.deepEqual(saved.branches[0].factors.map(factor=>factor.eventId),['existing','distinct','stresa','abstract']);
 assert.equal(saved.branches[0].factors[1].title,'Treaty');assert.equal(saved.branches[0].factors[3].title,'Nationalism');
});

test('cancelling or escaping branch event search preserves the draft and returns focus without saving',async()=>{
 for(const method of ['cancel','escape','suggestion escape']){
  const e=editor();let saved;
  const previous={id:'a',title:'Outcome',groups:[],branches:[{title:'Politics',factors:[{title:'Preserved argument',role:'Counterargument'}]}]};
  e.plugin.collect=()=>({events:[{id:'event',title:'An existing event'}]});
  e.plugin.saveAnalysis=async draft=>{saved=JSON.parse(JSON.stringify(draft));return saved;};e.plugin.editAnalysis(previous);
  const add=e.nodes().find(n=>n.textContent==='Add event');add.click();
  const input=e.field('Find an event for this branch');input.value='existing';input.events.input();
  if(method==='cancel')e.nodes().find(n=>n.textContent==='Cancel adding events').click();
  else {
   if(method==='suggestion escape')input.events.keydown({key:'ArrowDown',preventDefault(){}});
   const scope=e.app.keymap.scopes.at(-1);assert.equal(scope.parent,e.current().scope);
   let stopped=false;assert.equal(scope.handlers.find(handler=>handler.key==='Escape').callback({key:'Escape',preventDefault(){},stopPropagation(){stopped=true;}}),false);assert.equal(stopped,true);
  }
  const isHidden=node=>Boolean(node&&(node.hidden||isHidden(node.parentElement)));
  assert.equal(isHidden(input),true);assert.equal(e.doc.activeElement,add);assert.equal(e.current().closed,undefined);
  assert.equal(e.nodes().filter(n=>n.classList.contains('ht-analysis-factor-editor')).length,1);assert.equal(saved,undefined);assert.equal(e.calls.length,0);assert.equal(e.app.keymap.scopes.length,0);
  await e.submit();assert.deepEqual(saved,previous);
 }
 const e=editor();let writes=0;
 const previous={id:'a',title:'Outcome',groups:[],branches:[{title:'Politics',factors:[]}]};
 e.plugin.collect=()=>({events:[{id:'event',title:'An existing event'}]});e.plugin.saveAnalysis=async()=>{writes++;};e.plugin.editAnalysis(previous);
 e.nodes().find(n=>n.textContent==='Add event').click();const input=e.field('Find an event for this branch');input.value='existing';input.events.input();input.events.keydown({key:'Enter',preventDefault(){},stopPropagation(){}});
 e.nodes().find(n=>n.textContent==='Cancel').click();assert.equal(writes,0);assert.equal(previous.branches[0].factors.length,0);assert.equal(e.app.keymap.scopes.length,0);
});

test('branch event search keeps the modal save shortcut and releases its shortcut scope when removed',async()=>{
 for(const action of ['save','remove branch']){
  const e=editor();let saved;
  e.plugin.collect=()=>({events:[{id:'event',title:'An existing event'}]});e.plugin.saveAnalysis=async draft=>{saved=JSON.parse(JSON.stringify(draft));return saved;};
  e.plugin.editAnalysis({id:'a',title:'Outcome',groups:[],branches:[{title:'Politics',factors:[]}]});
  e.nodes().find(n=>n.textContent==='Add event').click();const input=e.field('Find an event for this branch'),scope=e.app.keymap.scopes.at(-1);
  assert.equal(scope.parent,e.current().scope);
  assert.equal(scope.handlers.find(handler=>handler.key==='Escape').callback({isComposing:true}),undefined);
  assert.equal(e.doc.activeElement,input);assert.equal(e.app.keymap.scopes.at(-1),scope);
  if(action==='save'){
   input.value='existing';input.events.input();input.events.keydown({key:'Enter',preventDefault(){},stopPropagation(){}});
   const form=e.nodes().find(n=>n.tagName==='form');
   scope.parent.handlers.find(handler=>handler.key==='Enter').callback({preventDefault(){},stopPropagation(){}});await form.submission;
   assert.equal(saved.branches[0].factors[0].eventId,'event');assert.equal(e.current().closed,true);
  }else {
   e.nodes().find(n=>n.textContent==='Remove branch').click();assert.equal(e.nodes().filter(n=>n.classList.contains('ht-analysis-branch-editor')).length,0);
   assert.equal(e.doc.activeElement,e.nodes().find(n=>n.textContent==='Add branch'));
   await e.submit();assert.deepEqual(saved.branches,[]);
  }
  assert.equal(e.app.keymap.scopes.length,0);
 }
});

test('connection picker explicitly creates an abstract outcome without requesting dates',async()=>{
 const e=editor();e.plugin.collect=()=>({events:[{id:'source',title:'Treaty',groups:['Japan'],start:{label:'1905'}}]});let saved;e.plugin.saveConnection=async draft=>{saved=draft;};e.plugin.editConnection({id:'source',groups:['Japan']},undefined,'outgoing');
 const input=e.field('Effect / related event');input.value='Nationalism becomes dominant';input.events.input();e.nodes().find(n=>n.textContent==='Create abstract factor: Nationalism becomes dominant').click();
 assert.equal(e.nodes().find(n=>n.attrs['aria-label']==='New to event date').hidden,true);await e.submit();assert.equal(saved.toNew.kind,'factor');assert.equal(saved.toNew.date,'');assert.equal(saved.toNew.title,'Nationalism becomes dominant');
});
test('event editor saves abstract factors without dates and retains their type on editing',async()=>{
 const e=editor();e.plugin.editEvent();e.field('Event title').value='Nationalism';e.field('Time type').value='factor';e.field('Time type').events.change();assert.equal(e.field('Start date').disabled,true);await e.submit();assert.equal(e.calls[0].args[0]['timeline-kind'],'factor');assert.equal(e.calls[0].args[0]['timeline-date'],undefined);
 const record={id:'factor',properties:{'timeline-kind':'factor','timeline-undated':true,'timeline-title':'Nationalism'}};e.plugin.standaloneEvents=[record];e.plugin.openEvent({storage:'timeline',standaloneId:'factor'});assert.equal(e.field('Time type').value,'factor');
});

test('analysis factor edits preserve existing inputs, collapsed branches, and scroll position',async()=>{
 const e=editor();let saved;
 e.plugin.saveAnalysis=async draft=>{saved=draft;return {...draft,id:'a'};};
 e.plugin.editAnalysis({id:'a',title:'Outcome',groups:[],causal:true,branches:[{title:'First',factors:[{title:'A'}]},{title:'Second',factors:[]}]});
 const content=e.current().contentEl,first=e.nodes().find(n=>n.classList.contains('ht-analysis-branch-editor')),input=e.field('Factor / argument');
 const originalFactor=e.nodes().find(n=>n.classList.contains('ht-analysis-factor-editor'));
 assert.equal(originalFactor.tagName,'details');assert.equal(originalFactor.open,false);
 first.open=false;first.events.toggle?.();content.scrollTop=800;
 const adds=e.nodes().filter(n=>n.textContent==='Add factor');adds[1].click();
 assert.equal(content.scrollTop,800);assert.equal(e.field('Factor / argument'),input);assert.equal(first.open,false);
 const addedFactor=e.nodes().filter(n=>n.classList.contains('ht-analysis-factor-editor'))[1];
 assert.equal(addedFactor.tagName,'details');assert.equal(addedFactor.open,true);
 const fields=e.nodes().filter(n=>n.attrs['aria-label']==='Factor / argument');fields[1].value='B';fields[1].events.input();
 assert.equal(e.doc.activeElement,fields[1]);assert.equal(e.nodes().find(n=>n.classList.contains('ht-analysis-factor-editor')),originalFactor);
 e.nodes().filter(n=>n.textContent==='Remove factor')[1].click();assert.equal(content.scrollTop,800);assert.equal(e.field('Factor / argument'),input);
 adds[1].click();const newField=e.nodes().filter(n=>n.attrs['aria-label']==='Factor / argument')[1];newField.value='C';newField.events.input();
 await e.submit();assert.equal(saved.branches[0].factors[0].title,'A');assert.equal(saved.branches[1].factors[0].title,'C');
});

test('analysis causal mode keeps branch disclosures, factor inputs and optional evidence intact',async()=>{
 const e=editor();let saved;
 const previous={id:'a',title:'Outcome',groups:['History'],headEventId:'missing-head',causal:false,branches:[
  {title:'First',eventId:'missing-outcome',factors:[{title:'A',eventId:'missing-support',role:'Counterargument',explanation:'Original mechanism',source:'Archive 12',perspectives:'One reading\n\nAnother reading',disputed:true}]},
  {title:'Second',factors:[]}
 ]};
 e.plugin.saveAnalysis=async draft=>{saved=draft;return {...draft,id:'a'};};e.plugin.editAnalysis(previous);
 const content=e.current().contentEl;
 const branches=e.nodes().filter(n=>n.classList.contains('ht-analysis-branch-editor'));
 const factor=e.nodes().find(n=>n.classList.contains('ht-analysis-factor-editor'));
 const evidence=e.nodes().find(n=>n.classList.contains('ht-analysis-evidence'));
 const title=e.field('Factor / argument'),explanation=e.field('How it contributed'),outcome=e.field('Branch outcome (optional)');
 let outcomePicker=outcome;while(!outcomePicker.classList.contains('ht-analysis-event-picker'))outcomePicker=outcomePicker.parentElement;
 const causal=e.nodes().find(n=>n.tagName==='input'&&n.type==='checkbox');
 const isHidden=node=>Boolean(node&&(node.hidden||isHidden(node.parentElement)));
 branches[1].open=false;branches[1].events.toggle?.();factor.open=true;factor.events.toggle?.();evidence.open=true;
 title.value='Revised factor';title.events.input();explanation.value='Revised mechanism';explanation.events.input();content.scrollTop=640;
 for(const value of [true,false,true]){
  causal.checked=value;causal.events.change();
  assert.equal(e.nodes().filter(n=>n.classList.contains('ht-analysis-branch-editor'))[1],branches[1]);
  assert.equal(branches[1].open,false);assert.equal(e.field('Factor / argument'),title);assert.equal(e.field('How it contributed'),explanation);
  assert.equal(e.nodes().find(n=>n.classList.contains('ht-analysis-factor-editor')),factor);assert.equal(factor.open,true);
  assert.equal(e.nodes().find(n=>n.classList.contains('ht-analysis-evidence')),evidence);assert.equal(evidence.open,true);
  assert.equal(e.field('Branch outcome (optional)'),outcome);assert.equal(isHidden(outcomePicker),value);
  assert.equal(content.scrollTop,640);
 }
 await e.submit();
 assert.equal(saved.causal,true);assert.equal(saved.headEventId,'missing-head');assert.equal(saved.branches[0].eventId,'missing-outcome');
 assert.equal(JSON.stringify(saved.branches[0].factors[0]),JSON.stringify({...previous.branches[0].factors[0],title:'Revised factor',explanation:'Revised mechanism'}));
 assert.equal(previous.branches[0].factors[0].title,'A','editing the draft leaves the saved analysis unchanged');
});

test('analysis attachment searches preserve unavailable references until an explicit replacement or clear',async()=>{
 for(const clear of [false,true]){
  const e=editor();let saved;
  e.plugin.saveAnalysis=async draft=>{saved=draft;return {...draft,id:'a'};};
  e.plugin.editAnalysis({id:'a',title:'Outcome',groups:[],headEventId:'missing-head',branches:[{title:'Branch',eventId:'missing-branch',factors:[{title:'Factor',eventId:'missing-factor'}]}]});
  const pickers=e.nodes().filter(n=>n.classList.contains('ht-analysis-event-picker'));
  assert.equal(pickers.length,3);
  for(const picker of pickers){
   const nodes=()=>picker.all(),button=text=>nodes().find(n=>n.tagName==='button'&&n.textContent===text);
   const attachment=nodes().find(n=>n.classList.contains('ht-analysis-attachment'));
   const search=nodes().find(n=>n.classList.contains('ht-analysis-event-search'));
   const input=nodes().find(n=>n.tagName==='input');
   assert.equal(attachment.hidden,false);assert.equal(search.hidden,true);assert.equal(button('Clear attached event').hidden,false);
   button('Change event').click();assert.equal(search.hidden,false);assert.equal(e.doc.activeElement,input);
   input.value='An unfinished search';input.events.input();button('Cancel search').click();
   assert.equal(search.hidden,true);assert.equal(attachment.hidden,false);assert.equal(e.doc.activeElement,button('Change event'));
   if(clear){button('Clear attached event').click();assert.equal(attachment.hidden,true);assert.equal(button('Clear attached event').hidden,true);}
  }
  await e.submit();
  assert.equal(saved.headEventId,clear?'':'missing-head');assert.equal(saved.branches[0].eventId,clear?'':'missing-branch');assert.equal(saved.branches[0].factors[0].eventId,clear?'':'missing-factor');
 }
});

test('analysis attachments open on demand and return focus to a visible control after choosing an event',async()=>{
 const e=editor();let saved;
 e.plugin.collect=()=>({events:[{id:'evidence',title:'Treaty',groups:[]}]});
 e.plugin.saveAnalysis=async draft=>{saved=draft;return {...draft,id:'a'};};e.plugin.editAnalysis();
 e.nodes().find(n=>n.textContent==='Add branch').click();e.nodes().find(n=>n.textContent==='Add factor').click();
 const attachTitles=['Attach head event','Attach branch outcome','Attach supporting event'];
 const pickers=e.nodes().filter(n=>n.classList.contains('ht-analysis-event-picker'));
 for(const [index,picker] of pickers.entries()){
  const nodes=()=>picker.all(),button=text=>nodes().find(n=>n.tagName==='button'&&n.textContent===text);
  const attachment=nodes().find(n=>n.classList.contains('ht-analysis-attachment'));
  const search=nodes().find(n=>n.classList.contains('ht-analysis-event-search'));
  const input=nodes().find(n=>n.tagName==='input');
  assert.equal(attachment.hidden,true);assert.equal(search.hidden,true);assert.equal(button('Clear attached event').hidden,true);
  button(attachTitles[index]).click();assert.equal(search.hidden,false);assert.equal(e.doc.activeElement,input);
  input.value='Treaty';input.events.input();input.events.keydown({key:'Enter',preventDefault(){}});
  assert.equal(search.hidden,true);assert.equal(attachment.hidden,false);assert.equal(e.doc.activeElement,button('Change event'));
 }
 await e.submit();assert.equal(saved.headEventId,'evidence');assert.equal(saved.branches[0].eventId,'evidence');assert.equal(saved.branches[0].factors[0].eventId,'evidence');
});

test('timeline choices omit selected lines but allow an exact match on the line being edited',()=>{
 const e=editor();e.plugin.collect=()=>({events:[{groups:['China','Japan','World History'],tags:[],category:'Politics'}]});e.plugin.editEvent();
 const input=e.field('Timelines (one name per line)'),picker=e.nodes().find(n=>n.attrs['aria-label']==='Choose existing timeline');
 input.value='China\nJapan';input.selectionStart=input.value.length;input.events.input();
 assert.deepEqual(picker.children.map(n=>n.value),['','World History']);
 assert.ok(e.nodes().some(n=>n.textContent==='Japan'&&n.tagName==='button'));
 input.value='China\n';input.selectionStart=input.value.length;input.events.input();
 const suggestions=e.nodes().filter(n=>n.tagName==='button'&&['China','Japan','World History'].includes(n.textContent));assert.equal(suggestions.some(n=>n.textContent==='China'),false);
 input.value='Japan';input.selectionStart=5;input.events.input();assert.ok(picker.children.some(n=>n.value==='China'));
});

test('adding historian perspectives retains the editor scroll and existing fields',()=>{
 const e=editor();e.plugin.editEvent();const content=e.current().contentEl;content.scrollTop=900;
 const title=e.field('Event title');e.nodes().find(n=>n.textContent==='Add historian perspective').click();
 assert.equal(content.scrollTop,900);assert.equal(e.field('Event title'),title);
 e.nodes().find(n=>n.textContent==='Remove perspective').click();assert.equal(content.scrollTop,900);
});

test('creating from an existing view reports the saved event instead of reopening another timeline',async()=>{
 const e=editor();let saved;e.plugin.editEvent(undefined,'Japan',event=>saved=event);e.enter();await e.submit();
 assert.deepEqual(e.calls.map(call=>call.method),['timeline']);assert.equal(saved.id,'timeline:saved');assert.equal(saved.title,'A new event');assert.ok(saved.start);assert.equal(e.current().closed,true);
});

test('typing a decade or century switches to period and saves without an end date',async()=>{
 for(const value of ['1940s','20th century','5th century BCE','c. 1940s']){
  const e=editor();e.plugin.editEvent();e.enter();const start=e.field('Start date');start.value=value;start.events.input({});
  assert.equal(e.field('Time type').value,'period');assert.equal(e.field('End date').disabled,false);
  await e.submit();assert.equal(e.calls[0].method,'timeline');assert.equal(e.calls[0].args[0]['timeline-end'],undefined);
 }
});
test('date inference waits for valid input and reverses only automatically selected empty-ended periods',()=>{
 const e=editor();e.plugin.editEvent();const start=e.field('Start date');
 start.value='20th cent';start.events.input({});assert.equal(e.field('Time type').value,'specific');
 start.value='1940s';start.events.input({isComposing:true});assert.equal(e.field('Time type').value,'specific');start.events.compositionend();assert.equal(e.field('Time type').value,'period');
 start.value='1940';start.events.input({});assert.equal(e.field('Time type').value,'specific');
 e.field('Time type').value='period';e.field('Time type').events.change();start.value='1941';start.events.input({});assert.equal(e.field('Time type').value,'period');
 e.field('Time type').value='specific';e.field('Time type').events.change();start.value='1940s';start.events.input({});e.field('End date').value='1950';start.value='1940';start.events.input({});assert.equal(e.field('Time type').value,'period');assert.equal(e.field('End date').value,'1950');
});

test('connection and analysis event pickers find a noun within a title and the Stresa typo',()=>{
 for(const kind of ['connection','analysis']){
  const e=editor();e.plugin.collect=()=>({events:[{id:'a',title:'The Anglo-German Naval Agreement',groups:[]},{id:'s',title:'The Stresa Front',groups:[]},{id:'r',title:'Russia',groups:[]}]});
  if(kind==='connection')e.plugin.editConnection({id:'a'});else e.plugin.editAnalysis();
  const input=e.field(kind==='connection'?'Effect / related event':'Head event (optional)');
  for(const query of ['stresa','sresa']){
   input.value=query;input.events.input();
   const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');assert.equal(box.children[0].textContent,'The Stresa Front · Undated');
  }
  input.events.keydown({key:'Enter',preventDefault(){}});assert.equal(input.value,'The Stresa Front');
 }
});

test('Command+Enter saves both new and existing connections and analyses through their form handlers',async()=>{
 for(const kind of ['connection','analysis'])for(const editing of [false,true]){
  const e=editor();let saved;
  const events=[{id:'a',title:'Cause',groups:[]},{id:'b',title:'Effect',groups:[]}];e.plugin.collect=()=>({events});
  const previous=kind==='connection'?{id:'link',from:'a',to:'b',relation:'prompted'}:{id:'analysis',title:'Outcome',groups:[],branches:[]};
  if(kind==='connection'){
   e.plugin.saveConnection=async(...args)=>{saved=args;};e.plugin.editConnection(events[0],editing?previous:undefined);
   if(!editing){const input=e.field('Effect / related event');input.value='Effect';input.events.input();input.events.keydown({key:'Enter',preventDefault(){}});}
   e.field('Explanation').value='Evidence';e.field('Explanation').focus();
  }else{
   e.plugin.saveAnalysis=async(...args)=>{saved=args;return {...args[0],id:'saved'};};e.plugin.editAnalysis(editing?previous:undefined);
   e.field('Outcome / question at the head').value='Updated outcome';e.field('Outcome / question at the head').events.input();
   e.nodes().find(n=>n.textContent==='Add branch').click();e.nodes().find(n=>n.textContent==='Add factor').click();
   const field=e.field('How it contributed');field.value='Evidence';field.events.input();field.focus();
  }
  const modal=e.current(),form=e.nodes().find(n=>n.tagName==='form');assert.equal(modal.scope.handlers.length,1);
  const handler=modal.scope.handlers[0];assert.equal(handler.key,'Enter');assert.equal(handler.modifiers.join(','),'Mod');
  assert.equal(handler.callback({preventDefault(){},stopPropagation(){}}),false);await form.submission;
  assert.ok(saved);assert.equal(saved[1],editing?previous:undefined);
  if(kind==='connection'){assert.equal(saved[0].to,'b');assert.equal(saved[0].explanation,'Evidence');}
  else assert.equal(saved[0].branches.at(-1).factors[0].explanation,'Evidence');
  assert.equal(modal.closed,true);assert.equal(modal.scope.handlers.length,0);
 }
});

test('connection and analysis shortcuts protect composition and pending saves, retain failures, and clean up on cancel',async()=>{
 for(const kind of ['connection','analysis']){
  const e=editor();let attempts=0,release;
  const save=async()=>{attempts++;if(attempts===1)throw new Error('Save failed');return new Promise(resolve=>release=resolve);};
  if(kind==='connection'){e.plugin.saveConnection=save;e.plugin.editConnection({id:'a'});}else{e.plugin.saveAnalysis=save;e.plugin.editAnalysis();}
  const modal=e.current(),form=e.nodes().find(n=>n.tagName==='form'),handler=modal.scope.handlers[0];
  const press=extra=>handler.callback({preventDefault(){},stopPropagation(){},...extra});
  press({isComposing:true});press({repeat:true});assert.equal(attempts,0);
  press();await form.submission;assert.equal(modal.closed,undefined);assert.equal(modal.scope.handlers.length,1);assert.match(e.nodes().find(n=>n.attrs.role==='alert').textContent,/Save failed/);
  press();press();assert.equal(attempts,2);release({id:'saved'});await form.submission;assert.equal(modal.scope.handlers.length,0);
  if(kind==='connection')e.plugin.editConnection({id:'a'});else e.plugin.editAnalysis();
  const cancelled=e.current();e.nodes().find(n=>n.textContent==='Cancel').click();assert.equal(cancelled.scope.handlers.length,0);
 }
});

test('aliases save as a list in both event storage modes and load in both editors',async()=>{
 for(const storage of ['timeline','note']){
  const e=editor();e.plugin.editEvent();e.enter();e.field('Save event as').value=storage;
  e.field('Aliases (one name per line)').value='MPBI\n七七事变\nmpbi';await e.submit();
  assert.deepEqual(Array.from(e.calls[0].args[0].aliases),['MPBI','七七事变']);
 }
 const e=editor();const record={id:'saved',properties:{'timeline-title':'Incident','timeline-date':'1937',aliases:['MPBI','七七事变']}};
 e.plugin.standaloneEvents=[record];e.plugin.editFromEvent({id:'timeline:saved',storage:'timeline',standaloneId:'saved'});
 assert.equal(e.field('Aliases (one name per line)').value,'MPBI\n七七事变');
 const note=new e.TFile('Incident');e.plugin.app.metadataCache.getFileCache=()=>({frontmatter:record.properties});e.plugin.editEvent(note);
 assert.equal(e.field('Aliases (one name per line)').value,'MPBI\n七七事变');
});

test('aliases find the same event in connections, both analysis pickers, and duplicate-name checks',()=>{
 const events=[{id:'a',title:'Marco Polo Bridge Incident',aliases:['MPBI','七七事变'],groups:[]},{id:'b',title:'Outcome',groups:[]}];
 for(const kind of ['connection','analysis','event']){
  const e=editor();e.plugin.collect=()=>({events});
  if(kind==='connection')e.plugin.editConnection(events[1],undefined,'incoming');
  if(kind==='analysis'){e.plugin.editAnalysis();e.nodes().find(n=>n.textContent==='Add branch').click();e.nodes().find(n=>n.textContent==='Add factor').click();}
  if(kind==='event')e.plugin.editEvent();
  const labels=kind==='connection'?['Cause / contributing event']:kind==='analysis'?['Head event (optional)','Supporting event (optional)']:['Event title'];
  for(const label of labels){
   const input=e.field(label);input.value='mpbi';input.events.input();
   if(kind==='event'){assert.ok(e.nodes().some(n=>n.textContent==='Edit: Marco Polo Bridge Incident'));continue;}
   const box=input.parentElement.children.find(n=>n.className==='ht-type-suggestions');
   assert.equal(box.children.length,1);assert.match(box.children[0].textContent,/Marco Polo Bridge Incident/);
   input.events.keydown({key:'Enter',preventDefault(){}});assert.equal(input.value,'Marco Polo Bridge Incident');
  }
 }
});

test('new relationships start blank while editing preserves the saved relationship',()=>{
 const e=editor();const event={id:'a',title:'Cause'};e.plugin.collect=()=>({events:[event]});
 e.plugin.editConnection(event);assert.equal(e.field('Relationship').value,'');
 e.plugin.editConnection(event,{id:'link',from:'a',to:'b',relation:'enabled'});assert.equal(e.field('Relationship').value,'enabled');
});

test('mobile reading mode guards all editor entry points and explicit editing restores them', () => {
  const e = editor({ mobile: true });
  const stored = { id: 'timeline:one', storage: 'timeline', standaloneId: 'one' };
  e.plugin.standaloneEvents = [{ id: 'one', properties: { 'timeline-title': 'Stored', 'timeline-date': '1900' } }];
  e.plugin.editEvent();
  e.plugin.editFromEvent(stored);
  e.plugin.openEvent(stored);
  e.plugin.editConnection({ id: 'one', title: 'Cause' });
  e.plugin.editAnalysis();
  assert.equal(e.modals.length, 0);
  assert.equal(e.notices.length, 5);
  assert.ok(e.notices.every(message => /reading mode/i.test(message)));
  assert.equal(e.calls.length, 0);

  e.plugin.setReadingMode(false);
  e.plugin.editFromEvent(stored);
  assert.equal(e.field('Event title').value, 'Stored');
  assert.equal(e.current().scope.handlers[0].key, 'Enter');
  e.current().close();
  e.plugin.editConnection({ id: 'one', title: 'Cause' });
  assert.ok(e.nodes().some(node => node.textContent === 'Connect events'));
  e.current().close();
  e.plugin.editAnalysis();
  assert.ok(e.nodes().some(node => node.textContent === 'New fishbone analysis'));
});

test('read-only event details reuse a native modal without adding editor controls or save shortcuts', () => {
  const e = editor({ mobile: true });
  const first = { id: 'a', title: 'Cause' }, second = { id: 'b', title: 'Outcome' };
  const render = title => panel => { const text = e.doc.createElement('p'); text.textContent = title; panel.appendChild(text); };
  const retireFirst = e.plugin.previewEvent(first, render(first.title));
  const modal = e.current();
  assert.equal(e.plugin.readingPreview, modal);
  assert.equal(e.modals.length, 1);
  assert.ok(e.nodes().some(node => node.attrs['aria-label'] === 'Event details: Cause'));
  assert.equal(modal.scope.handlers.length, 0);
  assert.equal(e.nodes().some(node => node.tagName === 'form'), false);
  assert.deepEqual(e.nodes().filter(node => node.tagName === 'button').map(node => node.textContent), ['Close details']);
  modal.contentEl.scrollTop = 400;

  const retireSecond = e.plugin.previewEvent(second, render(second.title));
  assert.equal(e.modals.length, 1, 'following an event does not stack another modal');
  assert.equal(e.plugin.readingPreview, modal);
  assert.ok(e.nodes().some(node => node.textContent === 'Outcome'));
  assert.equal(e.nodes().some(node => node.textContent === 'Cause'), false);
  assert.equal(modal.contentEl.scrollTop, 0);
  retireFirst();
  assert.equal(modal.closed, undefined, 'disposing an old renderer cannot close a newer linked event');
  assert.equal(e.plugin.readingPreview, modal);
  retireSecond();
  assert.equal(modal.closed, true);
  assert.equal(e.plugin.readingPreview, null);
  assert.equal(e.calls.length, 0);

  e.plugin.previewEvent(first, render(first.title));
  e.nodes().find(node => node.textContent === 'Close details').click();
  assert.equal(e.plugin.readingPreview, null);
  e.plugin.previewEvent(first, render(first.title));
  const reopened = e.current();
  e.plugin.setReadingMode(false);
  assert.equal(reopened.closed, true);
  assert.equal(e.plugin.readingPreview, null);
});

test('the undated picker reads a selected factor in reading mode and retains editing actions when unlocked', () => {
  const e = editor({ mobile: true });
  const factor = { id: 'factor', title: 'Rising nationalism', kind: 'factor', start: null };
  e.plugin.collect = () => ({ events: [factor, { id: 'dated', title: 'A dated event', start: { year: 1900 } }] });
  let selected;
  e.plugin.showUndated(event => { selected = event; });
  const picker = e.current();
  assert.equal(e.nodes().some(node => node.textContent === 'Connect'), false);
  assert.equal(e.nodes().some(node => node.textContent === 'A dated event'), false);
  e.nodes().find(node => node.tagName === 'button' && node.textContent === factor.title).click();
  assert.equal(selected, factor);
  assert.equal(picker.closed, true);
  assert.equal(e.calls.length, 0);
  assert.equal(e.modals.length, 1);

  e.plugin.setReadingMode(false);
  let edited, connected;
  e.plugin.editFromEvent = event => { edited = event; };
  e.plugin.editConnection = event => { connected = event; };
  e.plugin.showUndated();
  assert.ok(e.nodes().some(node => node.textContent === 'Connect'));
  e.nodes().find(node => node.tagName === 'button' && node.textContent === factor.title).click();
  assert.equal(edited, factor);
  e.plugin.showUndated();
  e.nodes().find(node => node.textContent === 'Connect').click();
  assert.equal(connected, factor);
});
