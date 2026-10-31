'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { renderTimeline } = require('../src/renderer');
const { eventFromFrontmatter, normalizeTags } = require('../src/model');
function dom() {
 const doc = { createElement: tag => new El(tag), createElementNS: (ns,tag) => new El(tag), events:{}, listeners:{},
  addEventListener(type,fn){(this.listeners[type]??=new Set()).add(fn);this.events[type]=event=>{for(const listener of this.listeners[type])listener(event);};},
  removeEventListener(type,fn){this.listeners[type]?.delete(fn);if(!this.listeners[type]?.size)delete this.events[type];} };
 class El {
  constructor(tag) { this.tagName=tag; this.ownerDocument=doc; this.children=[]; this.events={}; this.attrs={}; this.style={}; this.className=''; this.value=''; this.textContent=''; this.clientWidth=800; this.clientHeight=300; this.scrollLeft=0; this.scrollTop=0; this.classList={add: name=>this.classList.toggle(name,true),remove:name=>this.classList.toggle(name,false),toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));if(on)names.add(name);else names.delete(name);this.className=[...names].join(' ');}}; }
  focus(options) { this.focusOptions=options; doc.activeElement=this; }
  select() { this.selectionStart=0;this.selectionEnd=this.value.length; }
  getAttribute(key){return this.attrs[key];}
  contains(node){return this.all().includes(node);}
  querySelectorAll(selector){return this.all().slice(1).filter(n=>selector.startsWith('.')?n.className.split(' ').includes(selector.slice(1)):selector==='[data-event-id]'&&n.attrs['data-event-id']);}
  scrollIntoView(){this.revealed=true;}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}} appendChild(node){this.append(node);return node;}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}}
  replaceWith(node){const parent=this.parentElement;if(parent){parent.insertBefore(node,this);this.remove();}}
  replaceChildren(...nodes){for(const node of [...this.children])node.remove();this.append(...nodes);}
  insertBefore(node,before){node.remove();node.parentElement=this;const i=this.children.indexOf(before);this.children.splice(i<0?this.children.length:i,0,node);return node;}
  setAttribute(key,value){this.attrs[key]=value;} addEventListener(type,fn){this.events[type]=fn;} removeEventListener(type,fn){if(this.events[type]===fn)delete this.events[type];} get childNodes(){return this.children;} all(){return [this,...this.children.flatMap(n=>n.all())];}
 }
 const root=new El('div'); return {root, all:()=>root.all(), cls:name=>root.all().filter(n=>n.className.split(' ').includes(name)), label:name=>root.all().find(n=>n.attrs['aria-label']===name)};
}
const event=(title,date,groups,tags=[])=>eventFromFrontmatter({'timeline-title':title,'timeline-date':date,timeline:groups,'timeline-tags':tags},title+'.md',title).event;

// Model both layout-space measurements and transformed visual measurements.
// A packing regression must be visible even though the DOM itself is a fixture.
function mobileDom() {
 const d=dom(),doc=d.root.ownerDocument,create=doc.createElement,frames=new Map(),observers=[];
 let nextFrame=0;
 doc.defaultView={PointerEvent:class{},requestAnimationFrame:fn=>{frames.set(++nextFrame,fn);return nextFrame;},cancelAnimationFrame:id=>frames.delete(id),
  ResizeObserver:class{constructor(fn){this.callback=fn;this.targets=[];observers.push(this);}observe(el){this.targets.push(el);}disconnect(){this.disconnected=true;}}};
 const decorate=el=>{
  el.style.setProperty=(key,value)=>el.style[key]=value;el.style.getPropertyValue=key=>el.style[key]||'';el.style.removeProperty=key=>delete el.style[key];
  const captures=new Set();el.setPointerCapture=id=>captures.add(id);el.hasPointerCapture=id=>captures.has(id);el.releasePointerCapture=id=>captures.delete(id);
  Object.defineProperties(el,{
   offsetWidth:{get:()=>parseFloat(el.style.width)||el.clientWidth},
   offsetHeight:{get:()=>parseFloat(el.style.height)||(el.className.includes('ht-wall-stack')?el.children.length*20+Math.max(0,el.children.length-1)*12:el.className.includes('ht-wall-period')?38:20)}
  });
  el.getBoundingClientRect=()=>{
   let scale=1;for(let parent=el;parent;parent=parent.parentElement){const match=/scale\(([^)]+)\)/.exec(parent.style.transform||'');if(match)scale*=Number(match[1]);}
   return {left:0,top:0,width:el.offsetWidth*scale,height:el.offsetHeight*scale};
  };
  return el;
 };
 doc.createElement=tag=>decorate(create(tag));doc.createElementNS=(_,tag)=>doc.createElement(tag);
 const flush=()=>{let guard=0;while(frames.size){assert.ok(++guard<30,'resize/animation loop');const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());}};
 const resize=target=>{for(const observer of observers)if(!observer.disconnected&&observer.targets.includes(target))observer.callback();flush();};
 return {...d,flush,resize,observers};
}
const data=[event('Late','200',['B'],['war']),event('Early','20 BCE',['A'],['culture']),event('Shared','1 CE',['A','B'],['war'])];
const chooseTimeline=(d,name,checked=true)=>{const input=d.label('Include timeline: '+name);input.checked=checked;input.events.change();};
const excludeTag=(d,name,checked=true)=>{const input=d.label('Exclude tag: '+name);input.checked=checked;input.events.change();};
test('excluded tags hide shared-paper events across chronological views without removing the underlying records',()=>{
 const items=[event('Paper one','1930',['Germany'],['paper-1']),event('Paper two','1931',['Germany'],['paper-2']),
  event('Both papers','1932',['Germany','China'],['paper-1','paper-2']),event('Untagged','1933',['China']),event('Different tag','1934',['China'],['paper-10'])];
 for(const [mode,cls] of [['cards','ht-event-title'],['vertical','ht-vertical-item'],['wall','ht-wall-title']]){
  const d=dom(),cleanup=renderTimeline(d.root,items,{initialMode:mode,initialGroups:['Germany','China']});
  const titles=()=>d.cls(cls).map(n=>mode==='vertical'?n.children[1].textContent:n.textContent);
  excludeTag(d,'paper-1');
  assert.deepEqual(titles(),['Paper two','Untagged','Different tag']);
  excludeTag(d,'paper-2');assert.deepEqual(titles(),['Untagged','Different tag']);
  assert.deepEqual(cleanup.getState().excludedTags,['paper-1','paper-2']);
  d.label('No excluded tags').events.change();assert.equal(d.cls(cls).length,5);
  assert.deepEqual(cleanup.getState().groups,['China','Germany']);assert.equal(items.length,5);
  cleanup();
 }
});
test('tag exclusions take precedence over search, All/Any/None and Wall comparison',()=>{
 const items=[event('Hidden','1930',['A','B'],['paper-1','paper-2']),event('Kept','1931',['A'],['paper-2']),event('Other','1932',['B'])];
 for(const match of ['all','any','none']){
  const d=dom(),cleanup=renderTimeline(d.root,items,{initialGroups:['A'],initialQuery:'Hidden',initialMatch:match,initialExcludedTags:['paper-1']});
  assert.equal(d.label('Open event: Hidden'),undefined);cleanup();
 }
 const d=dom(),cleanup=renderTimeline(d.root,items,{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B',initialExcludedTags:['paper-1']});
 assert.equal(d.label('Timeline').disabled,true);assert.notEqual(d.label('Exclude tags').disabled,true);
 assert.deepEqual(d.cls('ht-wall-title').map(n=>n.textContent),['Kept','Other']);
 excludeTag(d,'paper-2');assert.deepEqual(d.cls('ht-wall-title').map(n=>n.textContent),['Other']);
 cleanup();
});
test('excluded tag snapshots normalize, persist through view changes, retain stale tags and clear explicitly',()=>{
 const d=dom(),states=[],cleanup=renderTimeline(d.root,data,{initialExcludedTags:[' #WAR ','war','missing',null,12],onStateChange:s=>states.push(s)});
 assert.deepEqual(cleanup.getState().excludedTags,['missing','war']);assert.equal(d.cls('ht-event-card').length,1);
 assert.ok(d.label('Exclude tag: missing').checked);
 d.all().find(n=>n.textContent==='Timeline'&&n.tagName==='button').events.click();assert.equal(d.cls('ht-vertical-item').length,1);
 states[0].excludedTags.push('Injected');cleanup.getState().excludedTags.push('Injected');
 assert.deepEqual(cleanup.getState().excludedTags,['missing','war']);
 excludeTag(d,'missing',false);assert.deepEqual(cleanup.getState().excludedTags,['war']);
 d.all().find(n=>n.textContent==='Clear all filters').events.click();assert.deepEqual(cleanup.getState().excludedTags,[]);assert.equal(d.cls('ht-vertical-item').length,3);
 assert.equal(d.label('Exclude tags').textContent,'No excluded tags');cleanup();
});
test('exclusion picker shares keyboard, Escape, stable focus and lifecycle behavior with timeline picker',()=>{
 const d=dom(),scopes=new Map(),released=[],cleanup=renderTimeline(d.root,data,{bindSearchEscape:(el,exit)=>{scopes.set(el,exit);return()=>released.push(el);}});
 const toggle=d.label('Exclude tags'),field=d.cls('ht-excluded-tags-filter')[0],panel=field.children[2],doc=d.root.ownerDocument;
 toggle.focus();field.events.keydown(timelineInput(toggle,{key:'ArrowDown'}));assert.equal(doc.activeElement,d.label('No excluded tags'));
 field.events.keydown(timelineInput(doc.activeElement,{key:'End'}));assert.equal(doc.activeElement,d.label('Exclude tag: war'));
 excludeTag(d,'war');assert.equal(panel.hidden,false);assert.equal(doc.activeElement,d.label('Exclude tag: war'));
 scopes.get(doc.activeElement)(timelineInput(doc.activeElement,{key:'Escape'}));assert.equal(panel.hidden,true);assert.equal(doc.activeElement,toggle);
 toggle.events.click();doc.events.pointerdown({target:d.label('Timeline')});assert.equal(panel.hidden,true);
 toggle.events.click();d.all().find(n=>n.textContent==='Hide filters').events.click();assert.equal(panel.hidden,true);
 cleanup();assert.equal(doc.events.pointerdown,undefined);assert.equal(released.length,scopes.size);
 excludeTag(d,'culture');assert.deepEqual(cleanup.getState().excludedTags,['war'],'retained handlers cannot mutate a closed view');
});
test('causal overview excludes tagged nodes and their links, while saved analyses preserve their authored contents',()=>{
 const a=event('Keep cause','1930',['A'],['paper-2']),b=event('Keep effect','1931',['A'],['paper-2']),hidden=event('Paper one','1932',['A'],['paper-1']);
 const connections=[{from:a.id,to:b.id},{from:a.id,to:hidden.id}];
 const d=dom(),cleanup=renderTimeline(d.root,[a,b,hidden],{initialMode:'graph',initialGraphMode:'events',initialGroup:'A',initialExcludedTags:['paper-1'],initialGraphSelected:hidden.id,connections});
 assert.ok(d.label('Explore connections: Keep cause'));assert.ok(d.label('Explore connections: Keep effect'));
 assert.equal(d.label('Explore connections: Paper one'),undefined);assert.equal(d.cls('ht-detail-heading').length,0);cleanup();
 const v=dom(),dispose=renderTimeline(v.root,[a,b,hidden],{initialMode:'graph',initialExcludedTags:['paper-1'],analyses:[{id:'saved',title:'Authored argument',groups:['A'],branches:[{title:'Evidence',factors:[{eventId:hidden.id,title:'Authored evidence'}]}]}],connections});
 assert.ok(v.label('Explore connections: Authored evidence'));dispose();
});
test('multiple timelines form a union in chronological views without duplicating shared events',()=>{
 for(const [mode,cls] of [['cards','ht-event-card'],['vertical','ht-vertical-item'],['wall','ht-wall-title']]){
  const d=dom(),cleanup=renderTimeline(d.root,[...data,event('Unselected','1900',['C'])],{initialMode:mode,initialGroups:['A']});
  assert.equal(d.cls(cls).length,2);
  chooseTimeline(d,'B');assert.equal(d.cls(cls).length,3);
  assert.deepEqual(cleanup.getState().groups,['A','B']);assert.equal(d.label('Timeline').textContent,'A, B');
  chooseTimeline(d,'A',false);assert.equal(d.cls(cls).length,2);assert.deepEqual(cleanup.getState().groups,['B']);
  d.label('All timelines').events.change();assert.equal(d.cls(cls).length,4);assert.deepEqual(cleanup.getState().groups,[]);
  assert.equal(d.label('Include timeline: B').checked,false);assert.equal(d.label('All timelines').checked,true);
  cleanup();
 }
});
test('timeline union is one condition for All, Any and None; snapshots do not share selection arrays',()=>{
 const d=dom(),states=[],items=[...data,event('Other','1900',['C'],['culture'])];
 const cleanup=renderTimeline(d.root,items,{initialGroups:['A','B'],initialTag:'culture',onStateChange:s=>states.push(s)});
 assert.deepEqual(d.cls('ht-event-title').map(n=>n.textContent),['Early']);
 d.label('Filter matching').value='any';d.label('Filter matching').events.change();assert.equal(d.cls('ht-event-card').length,4);
 d.label('Filter matching').value='none';d.label('Filter matching').events.change();assert.equal(d.cls('ht-event-card').length,0);
 d.label('Tag').value='war';d.label('Tag').events.change();assert.deepEqual(d.cls('ht-event-title').map(n=>n.textContent),['Other']);
 states[0].groups.push('Injected');const snapshot=cleanup.getState();snapshot.groups.push('Injected');
 assert.deepEqual(cleanup.getState().groups,['A','B']);
 d.all().find(n=>n.textContent==='Clear all filters').events.click();
 assert.deepEqual(cleanup.getState().groups,[]);assert.equal(d.label('Timeline').textContent,'All timelines');assert.equal(d.cls('ht-event-card').length,4);
 assert.deepEqual(states[1].groups,['A','B'],'later changes do not rewrite earlier history');
 cleanup();
});
test('explicit empty multi-selection overrides legacy single state and absent timelines remain removable',()=>{
 const cases=[
  [{initialGroup:'A'},['A'],2],
  [{initialGroup:'A',initialGroups:[]},[],3],
  [{initialGroup:'A',initialGroups:[' B ','B',null,'',12,'Removed']},['B','Removed'],2]
 ];
 for(const [options,groups,count] of cases){
  const d=dom(),cleanup=renderTimeline(d.root,data,options);
  assert.deepEqual(cleanup.getState().groups,groups);assert.equal(d.cls('ht-event-card').length,count);
  if(groups.includes('Removed')){assert.ok(d.label('Include timeline: Removed').checked);chooseTimeline(d,'Removed',false);assert.deepEqual(cleanup.getState().groups,['B']);}
  cleanup();
 }
});
test('comparison and view switching preserve the multi-selection and disable every picker control',()=>{
 const d=dom(),cleanup=renderTimeline(d.root,[...data,event('Other','1900',['C'])],{initialMode:'wall',initialGroups:['A','C'],initialAbove:'A',initialBelow:'B'});
 const compare=d.cls('ht-compare-toggle')[0].children[0];
 compare.checked=true;compare.events.change();
 assert.equal(d.label('Timeline').disabled,true);
 for(const name of ['A','B','C'])assert.equal(d.label('Include timeline: '+name).disabled,true);
 chooseTimeline(d,'B');assert.deepEqual(cleanup.getState().groups,['A','C'],'stale disabled handlers cannot change state');
 assert.equal(d.cls('ht-wall-title').length,3);
 d.all().find(n=>n.textContent==='Timeline'&&n.tagName==='button').events.click();
 assert.equal(d.label('Timeline').disabled,false);assert.equal(d.cls('ht-vertical-item').length,3);
 d.all().find(n=>n.textContent==='Wall chart'&&n.tagName==='button').events.click();
 compare.checked=false;compare.events.change();assert.equal(d.label('Timeline').disabled,false);
 assert.deepEqual(cleanup.getState().groups,['A','C']);assert.equal(d.cls('ht-wall-title').length,3);
 cleanup();
});
test('timeline popup stays open while choosing and closes with Escape, Done, outside click or hidden filters',()=>{
 const d=dom(),scopes=new Map(),released=[];
 const cleanup=renderTimeline(d.root,data,{bindSearchEscape:(input,exit)=>{scopes.set(input,exit);return()=>released.push(input);}});
 const toggle=d.label('Timeline'),panel=d.cls('ht-timeline-options')[0],wrapper=d.cls('ht-timeline-filter')[0],doc=d.root.ownerDocument;
 toggle.focus();wrapper.events.keydown(timelineInput(toggle,{key:'ArrowDown'}));
 assert.equal(panel.hidden,false);assert.equal(doc.activeElement,d.label('All timelines'));
 wrapper.events.keydown(timelineInput(doc.activeElement,{key:'End'}));assert.equal(doc.activeElement,d.label('Include timeline: B'));
 chooseTimeline(d,'B');assert.equal(panel.hidden,false);assert.equal(doc.activeElement,d.label('Include timeline: B'));
 const exit=scopes.get(doc.activeElement);
 for(const extra of [{isComposing:true},{metaKey:true},{ctrlKey:true},{altKey:true},{shiftKey:true}])assert.equal(exit(timelineInput(doc.activeElement,{key:'Escape',...extra})),false);
 assert.equal(exit(timelineInput(doc.activeElement,{key:'Escape'})),true);assert.equal(panel.hidden,true);assert.equal(doc.activeElement,toggle);
 toggle.events.click();d.cls('ht-timeline-done')[0].events.click();assert.equal(panel.hidden,true);
 toggle.events.click();doc.events.pointerdown({target:d.label('Include timeline: A')});assert.equal(panel.hidden,false);
 doc.events.pointerdown({target:d.label('Search historical events')});assert.equal(panel.hidden,true);
 toggle.events.click();d.all().find(n=>n.textContent==='Hide filters').events.click();assert.equal(panel.hidden,true);
 cleanup();assert.equal(doc.events.pointerdown,undefined);assert.equal(released.length,scopes.size);
});
test('multi-timeline fishbones retain cross-timeline links and pass separate names to analysis editors',()=>{
 const d=dom(),a=event('Germany event','1900',['Germany']),b=event('China event','1901',['China']),c=event('Elsewhere','1902',['Other']);
 const factor={id:'factor',title:'An abstract outcome',kind:'factor',groups:['China']};let edited;
 const cleanup=renderTimeline(d.root,[a,b,c,factor],{initialMode:'graph',initialGraphMode:'events',initialGroups:['Germany','China'],
  connections:[{from:a.id,to:b.id},{from:b.id,to:factor.id},{from:a.id,to:c.id}],onAnalysisEdit:(...args)=>edited=args});
 assert.ok(d.label('Explore connections: Germany event'));assert.ok(d.label('Explore connections: China event'));
 assert.ok(d.label('Explore connections: An abstract outcome'));assert.equal(d.label('Explore connections: Elsewhere'),undefined);
 assert.equal(d.label('Overview timeline'),undefined);
 d.all().find(n=>n.textContent==='Customize this fishbone').events.click();
 assert.deepEqual(edited[1],['China','Germany']);assert.deepEqual(edited[3].groups,['China','Germany']);
 assert.equal(edited[3].title,'China + Germany');
 d.all().find(n=>n.textContent==='New analysis').events.click();assert.deepEqual(edited[1],['China','Germany']);
 edited[1].push('Injected');assert.deepEqual(cleanup.getState().groups,['China','Germany']);
 cleanup();
});
test('saved analyses match any selected timeline, while None overview does not reapply a positive timeline filter',()=>{
 const d=dom(),analyses=['A','B','C'].map(name=>({id:name,title:name,groups:[name],branches:[]}));
 const cleanup=renderTimeline(d.root,data,{initialMode:'graph',initialGraphMode:'analyses',initialGroups:['A','B'],analyses});
 assert.deepEqual(d.label('Saved fishbone analysis').children.map(n=>n.value),['A','B']);cleanup();
 const v=dom(),a=event('A','1900',['A']),c=event('C','1901',['C']),dEvent=event('D','1902',['C']);
 const dispose=renderTimeline(v.root,[a,c,dEvent],{initialMode:'graph',initialGraphMode:'events',initialGroups:['A'],initialMatch:'none',connections:[{from:c.id,to:dEvent.id}]});
 assert.ok(v.label('Explore connections: C'));assert.ok(v.label('Explore connections: D'));assert.equal(v.label('Explore connections: A'),undefined);dispose();
});
test('search command reveals hidden filters in place and preserves view state and scroll',()=>{
 for(const mode of ['cards','vertical','wall','graph']){
  const d=dom();let state;
  const cleanup=renderTimeline(d.root,data,{initialMode:mode,initialCollapsed:true,initialQuery:'Early',initialSelected:'Early.md',onStateChange:value=>state=value});
  const nodes=d.all();const search=d.label('Search historical events');
  d.root.scrollTop=350;d.root.scrollLeft=10;
  const inner=[...d.cls('ht-wall-scroll'),...d.cls('ht-vertical-list'),...d.cls('ht-fishbone-scroll')];
  inner.forEach(el=>{el.scrollTop=80;el.scrollLeft=120;});
  assert.equal(d.cls('ht-toolbar')[0].hidden,true);
  cleanup.focusSearch();
  assert.equal(d.cls('ht-toolbar')[0].hidden,false);
  assert.equal(d.cls('ht-filter-actions')[0].hidden,false);
  assert.equal(search.ownerDocument.activeElement,search);
  assert.deepEqual(search.focusOptions,{preventScroll:true});
  assert.equal(search.selectionEnd,5);
  assert.equal(state.collapsed,false);assert.equal(state.mode,mode);assert.equal(state.selected,'Early.md');assert.equal(state.query,'Early');
  assert.deepEqual(d.all(),nodes);
  assert.equal(d.root.scrollTop,350);assert.equal(d.root.scrollLeft,10);
  inner.forEach(el=>{assert.equal(el.scrollTop,80);assert.equal(el.scrollLeft,120);});
  cleanup.focusSearch();assert.deepEqual(d.all(),nodes);
  cleanup();
 }
});

test('Escape exits search on all four views without navigation, clearing filters, or moving the chart',()=>{
 for(const mode of ['cards','vertical','wall','graph']){
  const d=dom();let scopedExit,released=false,opened=0;
  const cleanup=renderTimeline(d.root,data,{initialMode:mode,initialQuery:'Early',initialCollapsed:true,onOpen:()=>opened++,bindSearchEscape:(input,exit)=>{scopedExit=exit;return()=>{released=true;};}});
  cleanup.focusSearch();const search=d.label('Search historical events'),nodes=d.all();d.root.scrollTop=200;
  for(const ignored of [{key:'Enter'},{key:'Escape',isComposing:true},{key:'Escape',metaKey:true}]){
   assert.equal(scopedExit({...ignored,preventDefault(){throw new Error('Unexpected consumption');}}),false);assert.equal(search.ownerDocument.activeElement,search);
  }
  let prevented=false,stopped=false;
  const escape={key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}};
  assert.equal(scopedExit(escape),true);assert.ok(prevented&&stopped);
  assert.equal(search.ownerDocument.activeElement,d.cls('ht-root')[0]);assert.equal(d.root.scrollTop,200);assert.equal(search.value,'Early');assert.deepEqual(d.all(),nodes);assert.equal(opened,0);
  assert.equal(scopedExit(escape),false);
  cleanup.focusSearch();search.events.keydown(escape);assert.equal(search.ownerDocument.activeElement,d.cls('ht-root')[0]);
  cleanup();assert.equal(released,true);
 }
});
test('tags normalize, deduplicate and retain Unicode/nested labels',()=>{
 assert.deepEqual(normalizeTags('#War, war 外交 china/modern'),['war','外交','china/modern']);
 assert.deepEqual(normalizeTags(undefined),[]); assert.throws(()=>normalizeTags([{}]),/must be text/);
});
test('wall chart orders events and alternates sides on one horizontal plot',()=>{
 const d=dom(); renderTimeline(d.root,data,{initialMode:'wall'});
 assert.equal(d.cls('ht-wall-plot').length,1);
 assert.deepEqual(d.cls('ht-wall-title').map(n=>n.textContent),['Early','Shared','Late']);
 assert.equal(d.cls('ht-wall-above').filter(n=>n.children.length).length,2); assert.equal(d.cls('ht-wall-below').filter(n=>n.children.length).length,1);
 assert.deepEqual(d.cls('ht-wall-year').map(n=>n.textContent),['20 BCE','1 CE','200 CE',`${new Date().getFullYear()} CE`]);
 assert.deepEqual(d.cls('ht-wall-year').map(n=>n.style.gridColumn),['1','2','3','4']);
});
test('desktop Recentre follows the current wall axis without moving years or the outer page',()=>{
 for(const comparison of [false,true]){
  const d=mobileDom();
  const items=[...Array.from({length:20},(_,i)=>event(`Above ${i}`,'1900',['A'])),
   ...Array.from({length:10},(_,i)=>event(`Below ${i}`,'1901',['B']))];
  const cleanup=renderTimeline(d.root,items,{initialMode:'wall',initialCompare:comparison,initialAbove:'A',initialBelow:'B'});
  const scroll=d.cls('ht-wall-scroll')[0],plot=d.cls('ht-wall-plot')[0],axis=d.cls('ht-wall-axis')[0];
  const recentre=d.label('Recentre on time axis');
  assert.equal(recentre.parentElement,d.cls('ht-wall-viewport')[0]);
  assert.equal(recentre.parentElement,scroll.parentElement,'control stays outside the scrolling content');
  assert.equal(d.cls('ht-wall-help').length,0);
  scroll.clientTop=1;scroll.scrollLeft=912;scroll.scrollTop=540;d.root.scrollTop=333;d.root.scrollLeft=8;
  Object.defineProperty(scroll,'scrollHeight',{get:()=>parseFloat(plot.style.height)});
  scroll.getBoundingClientRect=()=>({top:100,height:scroll.clientHeight+2});
  axis.getBoundingClientRect=()=>({top:101+parseFloat(axis.style.top)-scroll.scrollTop,height:2});
  recentre.events.click();
  const centered=scroll.scrollTop;
  assert.equal(axis.getBoundingClientRect().top+1,101+scroll.clientHeight/2);
  assert.equal(scroll.scrollLeft,912);assert.equal(d.root.scrollTop,333);assert.equal(d.root.scrollLeft,8);
  recentre.events.click();assert.equal(scroll.scrollTop,centered);
  const stack=d.cls('ht-wall-above')[0],measure=stack.getBoundingClientRect;
  stack.getBoundingClientRect=()=>({...measure(),height:measure().height+100});
  d.resize(stack);recentre.events.click();
  assert.equal(scroll.scrollTop,centered+100,'uses the new axis after repacking');
  scroll.clientHeight=scroll.scrollHeight+100;recentre.events.click();
  assert.equal(scroll.scrollTop,0,'a chart that fits does not scroll');
  cleanup();scroll.scrollTop=24;recentre.events.click();assert.equal(scroll.scrollTop,24);
 }
});
test('Recentre clamps at the chart edge and is offered only on desktop Wall chart',()=>{
 const d=dom();renderTimeline(d.root,data,{initialMode:'wall'});
 const scroll=d.cls('ht-wall-scroll')[0],axis=d.cls('ht-wall-axis')[0];
 scroll.clientTop=1;scroll.scrollHeight=800;scroll.scrollTop=40;
 scroll.getBoundingClientRect=()=>({top:100});
 axis.getBoundingClientRect=()=>({top:101+750-scroll.scrollTop,height:2});
 d.label('Recentre on time axis').events.click();assert.equal(scroll.scrollTop,500);
 for(const mode of ['cards','vertical','wall','graph']){
  const mobile=dom();renderTimeline(mobile.root,data,{initialMode:mode,isMobile:true});
  assert.equal(mobile.label('Recentre on time axis'),undefined);
  if(mode!=='wall'){
   const desktop=dom();renderTimeline(desktop.root,data,{initialMode:mode});
   assert.equal(desktop.label('Recentre on time axis'),undefined);
  }
 }
});
test('comparison shows shared events once near the axis and ignores single-timeline filter',()=>{
 const d=dom();renderTimeline(d.root,data,{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B',initialGroup:'A'});
 assert.equal(d.cls('ht-wall-above').filter(n=>n.children.length).length,2);assert.equal(d.cls('ht-wall-below').filter(n=>n.children.length).length,1);
 assert.equal(d.label('Timeline').disabled,true);
 assert.equal(d.cls('ht-wall-title').filter(n=>n.textContent==='Shared').length,1);
 assert.equal(d.cls('ht-wall-shared-label').length,1);
});
test('comparison rejects identical selections and remains configurable when empty',()=>{
 const d=dom();renderTimeline(d.root,data,{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'A'});
 assert.equal(d.cls('ht-wall-plot').length,0); assert.match(d.cls('ht-wall-help')[0].textContent,/two different/);
 d.label('Below the line').value='B';d.label('Below the line').events.change();assert.equal(d.cls('ht-wall-plot').length,1);
});
test('tag filter and hashtag search work across all three views and retain state',()=>{
 const d=dom();let state;renderTimeline(d.root,data,{onStateChange:value=>state=value});
 d.label('Tag').value='war';d.label('Tag').events.change();assert.equal(d.cls('ht-event-card').length,2);
 d.all().find(n=>n.textContent==='Wall chart').events.click();assert.equal(d.cls('ht-wall-title').length,2);assert.equal(state.tag,'war');assert.equal(state.mode,'wall');
 d.all().find(n=>n.textContent==='Timeline' && n.tagName==='button').events.click();assert.equal(d.cls('ht-vertical-item').length,2);
 d.label('Tag').value='';d.label('Tag').events.change();d.label('Search historical events').value='#culture';d.label('Search historical events').events.input();assert.equal(d.cls('ht-vertical-item').length,1);
});
test('wall titles invoke the existing open/edit callback with the original event',()=>{
 const d=dom();let opened;renderTimeline(d.root,data,{initialMode:'wall',onOpen:e=>opened=e});d.cls('ht-wall-title')[0].events.click();assert.equal(opened.title,'Early');
});


test('same-year events form one centered stack while exact dates remain available on hover',()=>{
 const items=[event('December','1946-12',['A']),event('March','1946-03',['A']),event('January','1946-01-01',['A'])];
 const d=dom();renderTimeline(d.root,items,{initialMode:'wall'});
 assert.deepEqual(d.cls('ht-wall-year').map(n=>n.textContent),['1946 CE',`${new Date().getFullYear()} CE`]);
 const stack=d.cls('ht-wall-above')[0];assert.equal(stack.children.length,3);
 assert.deepEqual(d.cls('ht-wall-title').map(n=>n.textContent),['December','March','January']);
 assert.match(d.cls('ht-wall-title')[2].title,/1 Jan 1946 CE/);
 assert.equal(d.cls('ht-wall-date').length,0);
 assert.equal(d.cls('ht-wall-below').length,0);
});
test('year stacks align across comparison sides and periods span their endpoints',()=>{
 const range=eventFromFrontmatter({'timeline-title':'Period','timeline-date':'1946-10','timeline-end':'1949-10',timeline:['A','B']},'Period.md','Period').event;
 const d=dom();renderTimeline(d.root,[range,event('Other','1946-01',['B']),event('Later','1949',['A'])],{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 assert.deepEqual(d.cls('ht-wall-year').map(n=>n.textContent),['1946 CE','1949 CE',`${new Date().getFullYear()} CE`]);
 assert.equal(d.cls('ht-wall-above')[0].style.gridColumn,'2');assert.equal(d.cls('ht-wall-below')[0].style.gridColumn,'1');
 assert.equal(d.cls('ht-wall-above')[0].children.length,1);assert.equal(d.cls('ht-wall-below')[0].children.length,1);
 assert.deepEqual(d.cls('ht-wall-period').map(n=>n.style.gridColumn),['1 / 3']);
 assert.equal(d.cls('ht-wall-title').filter(n=>n.textContent==='Period').length,1);
 assert.equal(d.cls('ht-wall-shared-label').length,1);
});
test('BCE and CE years remain distinct and filtering rebuilds the year stacks',()=>{
 const d=dom();renderTimeline(d.root,[event('BCE','1 BCE',['A'],['old']),event('CE','1 CE',['A'],['new'])],{initialMode:'wall'});
 assert.deepEqual(d.cls('ht-wall-year').map(n=>n.textContent),['1 BCE','1 CE',`${new Date().getFullYear()} CE`]);
 d.label('Tag').value='new';d.label('Tag').events.change();
 assert.deepEqual(d.cls('ht-wall-year').map(n=>n.textContent),['1 CE',`${new Date().getFullYear()} CE`]);
});


test('decades span their full duration in proportional and wall views',()=>{
 const items=[event('Decade','1920s',['A']),event('Middle','1925',['A'])];
 const d=dom(); renderTimeline(d.root,items,{initialMode:'scale'});
 assert.equal(d.cls('ht-vertical-item').length,2);
 assert.equal(d.cls('ht-detail-date')[0].textContent,'1920s CE');
 assert.equal(d.cls('ht-scale-mark').length,0);
 const w=dom(); renderTimeline(w.root,items,{initialMode:'wall'});
 assert.deepEqual(w.cls('ht-wall-year').map(n=>n.textContent),['1920 CE','1925 CE','1929 CE',`${new Date().getFullYear()} CE`]);
 assert.equal(w.cls('ht-wall-period')[0].style.gridColumn,'1 / 4');
 assert.equal(w.cls('ht-wall-period-date')[0].textContent,'1920s CE');
});

test('legacy proportional mode opens vertical timeline with readable selected details',()=>{
 const d=dom();renderTimeline(d.root,data,{initialMode:'scale'});
 assert.equal(d.cls('ht-vertical-item').length,3);
 assert.equal(d.cls('ht-detail-heading')[0].textContent,'Early');
 d.cls('ht-vertical-item')[2].events.click();assert.equal(d.cls('ht-detail-heading')[0].textContent,'Late');
 assert.match(d.cls('ht-vertical-present')[0].textContent,new RegExp(String(new Date().getFullYear())));
});

test('all any none filter logic, importance and clear-all work together',()=>{
 const items=[{...event('Important','1900',['A'],['war']),important:true},event('Other','1901',['B'],['culture'])];
 const d=dom();renderTimeline(d.root,items,{});
 d.label('Include timeline: A').checked=true;d.label('Include timeline: A').events.change();
 d.label('Tag').value='culture';d.label('Tag').events.change();assert.equal(d.cls('ht-event-card').length,0);
 d.label('Filter matching').value='any';d.label('Filter matching').events.change();assert.equal(d.cls('ht-event-card').length,2);
 d.label('Filter matching').value='none';d.label('Filter matching').events.change();assert.equal(d.cls('ht-event-card').length,0);
 d.all().find(n=>n.textContent==='Clear all filters').events.click();assert.equal(d.cls('ht-event-card').length,2);
 d.label('Important events').checked=true;d.label('Important events').events.change();assert.equal(d.cls('ht-event-card').length,1);assert.equal(d.cls('ht-important').length,1);
 for(const name of ['Timeline','Wall chart']){d.all().find(n=>n.textContent===name && n.tagName==='button').events.click();assert.ok(d.cls('ht-important').length>=1);}
});

test('connections display both directions and graph navigation follows a chain',()=>{
 const items=[event('A','1900',['A']),event('B','1901',['A']),event('C','1902',['A'])];
 const links=[{id:'ab',from:'A.md',to:'B.md',relation:'prompted',explanation:'Evidence',source:'Book'}, {id:'bc',from:'B.md',to:'C.md',relation:'enabled',disputed:true}];
 const d=dom();renderTimeline(d.root,items,{initialMode:'graph',initialGraphSelected:'B.md',connections:links});
 assert.equal(d.cls('ht-fishbone-card').length,1);
 assert.equal(d.cls('ht-connection-row').length,2);
 assert.ok(d.all().some(n=>n.textContent==='enabled · disputed'));
 d.label('Explore connections: C').events.click();assert.equal(d.cls('ht-detail-heading')[0].textContent,'C');
 assert.equal(d.cls('ht-connection-row').length,1);
});

test('long press reorders tabs directly and keyboard saves roll back on failure',async()=>{
 const d=dom();let saved;renderTimeline(d.root,data,{onViewOrderChange:async order=>{saved=order;}});
 const modes=d.cls('ht-view-modes')[0];
 modes.children.forEach((tab,index)=>{tab.getBoundingClientRect=()=>({left:index*100,right:index*100+99,top:0,bottom:40});});
 modes.children[0].events.pointerdown({button:0,pointerId:1,clientX:10,clientY:10});
 await new Promise(resolve=>setTimeout(resolve,420));
 modes.events.pointermove({pointerId:1,clientX:210,clientY:10,preventDefault(){}});
 assert.equal(modes.children[0].textContent,'Chronicle');
 for(let i=0;i<8;i++) modes.events.pointermove({pointerId:1,clientX:210,clientY:10,preventDefault(){}});
 assert.equal(modes.children[0].textContent,'Chronicle');
 await modes.events.pointerup();assert.deepEqual(saved,['vertical','wall','cards','graph']);
 assert.equal(d.all().some(n=>n.textContent==='Reorder views'),false);
 const bad=dom();renderTimeline(bad.root,data,{onViewOrderChange:async()=>{throw new Error('Disk unavailable');}});
 await bad.cls('ht-view-modes')[0].children[1].events.keydown({altKey:true,key:'ArrowLeft',preventDefault(){}});
 assert.equal(bad.cls('ht-view-modes')[0].children[0].textContent,'Chronicle');
 assert.equal(bad.cls('ht-order-status')[0].textContent,'Disk unavailable');
});

test('all charts exclude undated events while retaining a management entry',()=>{
 const unknown={...event('Unknown','1900',[]),start:null};
 for(const mode of ['cards','vertical','wall','graph']) {
  const d=dom();renderTimeline(d.root,[event('Known','1900',[]),unknown],{initialMode:mode,onUndated(){}});
  assert.ok(d.all().some(n=>n.textContent==='Undated events (1)'));
  assert.equal(d.all().some(n=>n.textContent==='Unknown'),false);
 }
});
test('search defaults to ignoring case and can become case-sensitive; collapsed filters keep tabs',()=>{
 const d=dom();renderTimeline(d.root,[event('Politics','1900',[])],{});
 const search=d.label('Search historical events');search.value='politics';search.events.input();assert.equal(d.cls('ht-event-card').length,1);
 const ignore=d.label('Ignore case');ignore.checked=false;ignore.events.change();assert.equal(d.cls('ht-event-card').length,0);
 d.all().find(n=>n.textContent==='Hide filters').events.click();assert.equal(d.cls('ht-toolbar')[0].hidden,true);assert.equal(d.cls('ht-view-modes').length,1);
});
test('wall restores original size without zoom, and fishbones omit disconnected events',()=>{
 const items=[event('A','1900',[]),event('B','1901',[]),event('C','1902',[])];const d=dom();renderTimeline(d.root,items,{initialMode:'wall',initialWallZoom:2.5});
 assert.equal(d.cls('ht-wall-plot')[0].style.width,'1040px');assert.equal(d.label('Wall chart zoom'),undefined);
 const g=dom();renderTimeline(g.root,items,{initialMode:'graph',connections:[{from:'A.md',to:'B.md',relation:'prompted'}]});assert.equal(g.cls('ht-fishbone-card').length,1);assert.equal(g.label('Explore connections: C'),undefined);
});

test('escape cancels a held tab without persisting a partial reorder',async()=>{
 const d=dom();let writes=0;renderTimeline(d.root,data,{onViewOrderChange:async()=>{writes++;}});
 const modes=d.cls('ht-view-modes')[0];const first=modes.children[0];
 modes.children.forEach((tab,index)=>{tab.getBoundingClientRect=()=>({left:index*100,right:index*100+99,top:0,bottom:40});});
 first.events.pointerdown({button:0,pointerId:1,clientX:10,clientY:10});await new Promise(resolve=>setTimeout(resolve,420));
 modes.events.pointermove({pointerId:1,clientX:310,clientY:10,preventDefault(){}});
 await first.events.keydown({key:'Escape'});await modes.events.pointerup();assert.equal(writes,0);assert.equal(modes.children[0],first);assert.equal(first.style.transform,'');
});

test('one timeline fishbone groups category events with directed edges and preserves clicks and viewport',()=>{
 const items=[event('A','1900',['X']),event('B','1901',['X']),event('C','1902',['X'])];const d=dom();let edit;
 renderTimeline(d.root,items,{initialMode:'graph',onAnalysisEdit:(...args)=>edit=args,connections:[{from:'A.md',to:'B.md',relation:'prompted'},{from:'B.md',to:'C.md',relation:'enabled'}]});
 assert.equal(d.cls('ht-fishbone-card').length,1);assert.equal(d.label('Fishbone outcome'),undefined);
 assert.equal(d.cls('ht-fishbone-category').length,2);assert.equal(d.cls('ht-fishbone-event').length,4);assert.ok(d.label('Explore connections: X'));
 const edges=d.all().filter(n=>n.attrs.class==='ht-fishbone-causal-arrow'&&n.attrs['data-from']);assert.equal(edges.length,2);assert.equal(edges[0].attrs['data-from'],'A.md');assert.equal(edges[0].attrs['data-to'],'B.md');assert.ok(edges.every(edge=>!edge.attrs.d.includes(' C ')));assert.ok(edges.every(edge=>edge.attrs.d.includes(' L ')));
 const viewport=d.label('Fishbone: X');viewport.scrollLeft=123;d.label('Explore connections: C').events.click();assert.equal(d.cls('ht-detail-heading')[0].textContent,'C');assert.equal(d.label('Fishbone: X'),viewport);assert.equal(viewport.scrollLeft,123);
 d.label('Explore connections: A').events.click();assert.equal(d.cls('ht-detail-heading')[0].textContent,'A');
 d.all().find(n=>n.textContent==='Customize this fishbone').events.click();const seed=edit[3];assert.equal(seed.title,'X');assert.equal(seed.causal,true);assert.equal(seed.branches[0].title,'Other factors');assert.deepEqual(seed.branches[0].factors.map(factor=>factor.eventId),['A.md','B.md']);assert.match(seed.branches[0].factors[0].explanation,/prompted → B/);
});

test('releasing a held tab outside all drop zones keeps the original order',async()=>{
 const d=dom();let writes=0;renderTimeline(d.root,data,{onViewOrderChange:async()=>{writes++;}});
 const modes=d.cls('ht-view-modes')[0];const first=modes.children[0];
 modes.children.forEach((tab,index)=>{tab.getBoundingClientRect=()=>({left:index*100,right:index*100+99,top:0,bottom:40});});
 first.events.pointerdown({button:0,pointerId:1,clientX:10,clientY:10});await new Promise(resolve=>setTimeout(resolve,420));
 modes.events.pointermove({pointerId:1,clientX:310,clientY:10,preventDefault(){}});
 modes.events.pointermove({pointerId:1,clientX:700,clientY:200,preventDefault(){}});
 await modes.events.pointerup();assert.equal(writes,0);assert.equal(modes.children[0],first);
});

test('analyses render without dated events and remain scoped to their selected timeline',()=>{
 const d=dom();let edited;const analyses=[{id:'a',title:'Why expansion?',groups:['Japan'],branches:[{title:'Economics',factors:[{title:'Economic pressure',explanation:'Mechanism',perspectives:'Historian A disagrees'}]}]},{id:'b',title:'Another question',groups:['Other'],branches:[]}];
 renderTimeline(d.root,[],{initialMode:'graph',initialGroup:'Japan',analyses,onAnalysisEdit:(...args)=>edited=args});
 assert.equal(d.cls('ht-fishbone-card').length,1);assert.equal(d.label('Saved fishbone analysis').children.length,1);assert.equal(d.label('Cause and effect diagram type').children.length,2);
 d.label('Explore connections: Economic pressure').events.click();assert.ok(d.all().some(n=>n.textContent==='Mechanism'));assert.ok(d.all().some(n=>n.textContent==='Historian A disagrees'));
 d.all().find(n=>n.textContent==='Edit analysis').events.click();assert.equal(edited[0],analyses[0]);
 const mode=d.label('Cause and effect diagram type');mode.value='events';mode.events.change();assert.equal(d.cls('ht-fishbone-card').length,0);
 d.all().find(n=>n.textContent==='New analysis').events.click();assert.deepEqual(edited[1],['Japan']);
});
test('analysis evidence expands saved causal chains including undated events and bounded cycles',()=>{
 const d=dom();const a=event('A','1900',['Japan']),b=event('B','1901',['Japan']),u={id:'u',title:'Undated cause'};
 const links=[{from:a.id,to:b.id,relation:'prompted'},{from:u.id,to:a.id,relation:'enabled'},{from:b.id,to:u.id,relation:'feedback'}];
 renderTimeline(d.root,[a,b,u],{initialMode:'graph',analyses:[{id:'analysis',title:'Broader outcome',groups:['Japan'],branches:[{title:'Military',factors:[{title:'An argument',eventId:b.id}]}]}],connections:links});
 d.label('Explore connections: An argument').events.click();
 assert.equal(d.cls('ht-analysis-chain').length,1);
 for(let i=0;i<4;i++){const branch=d.cls('ht-analysis-chain')[i];branch.open=true;branch.events.toggle();}
 assert.ok(d.all().some(n=>n.textContent==='Cycle returns to B'));assert.ok(d.all().some(n=>n.textContent==='Undated cause → A · enabled'));
 const mode=d.label('Cause and effect diagram type');mode.value='events';mode.events.change();assert.equal(d.cls('ht-fishbone-card').length,1);assert.ok(d.label('Explore connections: A'));assert.equal(d.label('Explore connections: Undated cause'),undefined);
});

test('causal history waits for expansion and bounds wide fan-in without duplicating reopened branches',()=>{
 const target=event('Outcome','1950',['History']);
 const sources=Array.from({length:150},(_,i)=>event('Cause '+i,'1900',['History']));
 const d=dom();renderTimeline(d.root,[target,...sources],{initialMode:'graph',initialGraphSelected:target.id,
  analyses:[{id:'a',title:'Why?',branches:[{title:'Causes',factors:[{eventId:target.id}]}]}],
  connections:sources.map(source=>({from:source.id,to:target.id,relation:'enabled'}))});
 const history=d.cls('ht-analysis-chain')[0];assert.equal(d.cls('ht-analysis-chain').length,1);
 history.events.toggle();assert.equal(d.cls('ht-analysis-chain').length,1);
 history.open=true;history.events.toggle();assert.equal(d.cls('ht-analysis-chain').length,61);
 assert.ok(history.children.some(n=>n.textContent==='Continue from this event’s details to explore further.'));
 history.open=false;history.events.toggle();history.open=true;history.events.toggle();assert.equal(d.cls('ht-analysis-chain').length,61);
});

test('selecting timeline events preserves the mounted list, scroll position and focused item',()=>{
 const d=dom();let state;const many=Array.from({length:80},(_,i)=>event('Event '+i,String(1800+i),['History']));
 renderTimeline(d.root,many,{initialMode:'vertical',onStateChange:value=>state=value});
 const list=d.cls('ht-vertical-list')[0],buttons=d.cls('ht-vertical-item'),panel=d.cls('ht-detail-panel')[0];list.scrollTop=1440;
 buttons[63].events.click();assert.equal(d.cls('ht-vertical-list')[0],list);assert.equal(list.scrollTop,1440);assert.equal(d.cls('ht-vertical-item')[63],buttons[63]);assert.equal(d.cls('ht-detail-panel')[0],panel);assert.equal(d.cls('ht-detail-heading')[0].textContent,'Event 63');assert.equal(state.selected,many[63].id);
 assert.equal(buttons[0].attrs['aria-pressed'],'false');assert.equal(buttons[63].attrs['aria-pressed'],'true');
 buttons[64].events.click();assert.equal(list.scrollTop,1440);assert.equal(buttons[63].attrs['aria-pressed'],'false');assert.equal(buttons[64].attrs['aria-pressed'],'true');assert.equal(d.cls('ht-detail-heading')[0].textContent,'Event 64');
});

function timelineInput(target, values={}) {
 return {target,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...values};
}

test('timeline keys follow the filtered chronology, move focus and reveal only within the list',()=>{
 const d=dom(),changes=[];
 const items=[event('Last','1950',['A']),event('Hidden','1910',['B']),event('First','1900',['A']),event('Middle','1930',['A']),event('Later','1940',['A'])];
 const cleanup=renderTimeline(d.root,items,{initialMode:'vertical',initialGroup:'A',initialSelected:'Middle.md',onStateChange:(state,change)=>changes.push({state,change})});
 const list=d.cls('ht-vertical-list')[0],buttons=d.cls('ht-vertical-item'),panel=d.cls('ht-detail-panel')[0];
 assert.deepEqual(buttons.map(item=>item.attrs['data-event-id']),['First.md','Middle.md','Later.md','Last.md']);
 assert.deepEqual(buttons.map(item=>item.tabIndex),[-1,0,-1,-1]);
 list.clientHeight=120;list.scrollHeight=320;list.scrollTop=0;d.root.scrollTop=333;panel.scrollTop=44;
 list.getBoundingClientRect=()=>({top:100,bottom:220,height:120});
 buttons.forEach((item,i)=>{item.getBoundingClientRect=()=>({top:100+i*80-list.scrollTop,bottom:180+i*80-list.scrollTop,height:80});});
 const press=key=>{const input=timelineInput(d.root.ownerDocument.activeElement||buttons[1].children[1],{key});list.events.keydown(input);assert.ok(input.prevented&&input.stopped);};
 buttons[1].events.click();assert.equal(changes.length,0,'reselecting the current item creates no history entry');
 press('ArrowDown');
 assert.equal(cleanup.getState().selected,'Later.md');assert.equal(d.cls('ht-detail-heading')[0].textContent,'Later');
 assert.equal(d.root.ownerDocument.activeElement,buttons[2]);assert.deepEqual(buttons[2].focusOptions,{preventScroll:true});
 assert.deepEqual(buttons.map(item=>item.tabIndex),[-1,-1,0,-1]);
 assert.equal(buttons[1].attrs['aria-pressed'],'false');assert.equal(buttons[2].attrs['aria-pressed'],'true');
 assert.ok(buttons[2].getBoundingClientRect().bottom<=220);assert.ok(list.scrollTop>0);assert.equal(buttons[2].revealed,undefined);
 assert.equal(d.root.scrollTop,333);assert.equal(panel.scrollTop,44);assert.equal(d.cls('ht-vertical-list')[0],list);assert.equal(d.cls('ht-detail-panel')[0],panel);
 press('ArrowUp');assert.equal(cleanup.getState().selected,'Middle.md');
 press('Home');assert.equal(cleanup.getState().selected,'First.md');assert.equal(list.scrollTop,0);
 const firstChanges=changes.length;press('ArrowUp');press('Home');assert.equal(changes.length,firstChanges);
 press('End');assert.equal(cleanup.getState().selected,'Last.md');assert.ok(buttons[3].getBoundingClientRect().bottom<=220);
 const lastChanges=changes.length;press('ArrowDown');press('End');assert.equal(changes.length,lastChanges);
 assert.ok(changes.every(({change})=>change.navigation===true));assert.equal(d.root.scrollTop,333);assert.deepEqual(d.cls('ht-vertical-item'),buttons);
 cleanup();
});

test('timeline keys leave modified, composing and editable input untouched',()=>{
 const d=dom(),cleanup=renderTimeline(d.root,data,{initialMode:'vertical'}),list=d.cls('ht-vertical-list')[0],item=d.cls('ht-vertical-item')[0];
 const editable=d.root.ownerDocument.createElement('div'),child=d.root.ownerDocument.createElement('span');editable.isContentEditable=true;editable.append(child);list.append(editable);
 const input=d.root.ownerDocument.createElement('input');list.append(input);
 for(const ignored of [{key:'ArrowLeft'},{key:'ArrowDown',defaultPrevented:true},{key:'ArrowDown',isComposing:true},...['altKey','ctrlKey','metaKey','shiftKey'].map(key=>({key:'ArrowDown',[key]:true})),{key:'ArrowDown',target:child},{key:'ArrowDown',target:input}]){
  const event=timelineInput(item,ignored);list.events.keydown(event);assert.equal(event.prevented,false);assert.equal(event.stopped,false);assert.equal(cleanup.getState().selected,'Early.md');
 }
 assert.equal(d.cls('ht-detail-panel')[0].events.keydown,undefined);assert.equal(d.cls('ht-root')[0].events.keydown,undefined);
 cleanup();
});

test('desktop timeline wheel gestures step once, coalesce small deltas and leave inertia quiet',t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const d=dom(),changes=[],items=Array.from({length:6},(_,i)=>event('Event '+i,String(1900+i),['A']));
 const cleanup=renderTimeline(d.root,items,{initialMode:'vertical',onStateChange:(state,change)=>changes.push({state,change})});
 const list=d.cls('ht-vertical-list')[0],buttons=d.cls('ht-vertical-item'),panel=d.cls('ht-detail-panel')[0];d.root.scrollTop=250;
 const wheel=(deltaY,elapsed=20,extra={})=>{now+=elapsed;const input=timelineInput(buttons[0],{deltaY,deltaX:0,deltaMode:0,...extra});list.events.wheel(input);assert.ok(input.prevented&&input.stopped);return cleanup.getState().selected;};
 assert.equal(wheel(24),'Event 0.md');assert.equal(wheel(24),'Event 1.md');assert.equal(changes.length,1);
 assert.equal(d.root.ownerDocument.activeElement,buttons[1]);assert.deepEqual(buttons[1].focusOptions,{preventScroll:true});
 assert.equal(wheel(600),'Event 1.md');assert.equal(wheel(600,300),'Event 2.md','one large wheel event advances only one item');
 assert.equal(wheel(-3,300,{deltaMode:1}),'Event 1.md','line-based wheel packets are normalized');
 assert.equal(wheel(1,300,{deltaMode:2}),'Event 2.md','page-based wheel packets are normalized');
 assert.equal(wheel(24,300),'Event 2.md');assert.equal(wheel(24,300),'Event 2.md','separate small gestures do not accumulate');assert.equal(wheel(24),'Event 3.md');
 assert.equal(wheel(24,300),'Event 3.md');assert.equal(wheel(-24),'Event 3.md','direction reversal drops the previous partial movement');assert.equal(wheel(-24),'Event 2.md');
 assert.equal(d.cls('ht-vertical-list')[0],list);assert.equal(d.cls('ht-detail-panel')[0],panel);assert.equal(d.root.scrollTop,250);
 const home=timelineInput(buttons[2],{key:'Home'});list.events.keydown(home);const before=changes.length;
 assert.equal(wheel(-120,300),'Event 0.md');assert.equal(changes.length,before,'scrolling beyond an endpoint creates no history entry');
 assert.ok(changes.every(({change})=>change.navigation===true));cleanup();
});

test('timeline wheel leaves editing, zoom gestures, horizontal scrolling and mobile scrolling alone',()=>{
 const d=dom(),cleanup=renderTimeline(d.root,data,{initialMode:'vertical'}),list=d.cls('ht-vertical-list')[0],item=d.cls('ht-vertical-item')[0];
 const ignored=[{deltaY:0},{deltaY:20,deltaX:50},{deltaY:20,deltaX:20},{deltaY:NaN},{deltaY:120,defaultPrevented:true},...['altKey','ctrlKey','metaKey','shiftKey'].map(key=>({deltaY:120,[key]:true}))];
 for(const values of ignored){const input=timelineInput(item,{deltaY:120,deltaX:0,...values});list.events.wheel(input);assert.equal(input.prevented,false);assert.equal(input.stopped,false);}
 const search=d.label('Search historical events');search.focus();const whileEditing=timelineInput(item,{deltaY:120,deltaX:0});list.events.wheel(whileEditing);assert.equal(whileEditing.prevented,false);assert.equal(cleanup.getState().selected,'Early.md');
 assert.equal(d.cls('ht-detail-panel')[0].events.wheel,undefined);assert.equal(d.cls('ht-root')[0].events.wheel,undefined);cleanup();
 const mobile=dom(),mobileCleanup=renderTimeline(mobile.root,data,{initialMode:'vertical',isMobile:true});
 assert.equal(mobile.cls('ht-vertical-list')[0].events.wheel,undefined);assert.equal(typeof mobile.cls('ht-vertical-list')[0].events.keydown,'function');mobileCleanup();
});

test('timeline navigation handlers are inert after filters replace their list or the renderer closes',()=>{
 const d=dom(),changes=[],cleanup=renderTimeline(d.root,data,{initialMode:'vertical',onStateChange:state=>changes.push(state)});
 const oldList=d.cls('ht-vertical-list')[0],oldKey=oldList.events.keydown,oldWheel=oldList.events.wheel,oldClick=d.cls('ht-vertical-item')[2].events.click;
 const search=d.label('Search historical events');search.value='Shared';search.events.input();
 const list=d.cls('ht-vertical-list')[0];assert.notEqual(list,oldList);assert.equal(cleanup.getState().selected,'Shared.md');
 const checkInactive=(key,wheel,click)=>{const before=changes.length,k=timelineInput(oldList,{key:'End'}),w=timelineInput(oldList,{deltaY:120,deltaX:0});key(k);wheel(w);click();assert.equal(k.prevented,false);assert.equal(w.prevented,false);assert.equal(changes.length,before);assert.equal(cleanup.getState().selected,'Shared.md');};
 checkInactive(oldKey,oldWheel,oldClick);assert.equal(oldList.events.keydown,undefined);assert.equal(oldList.events.wheel,undefined);
 const key=list.events.keydown,wheel=list.events.wheel,click=d.cls('ht-vertical-item')[0].events.click;cleanup();checkInactive(key,wheel,click);
 assert.equal(list.events.keydown,undefined);assert.equal(list.events.wheel,undefined);
});

test('abstract factors appear in Cause and Effect but stay out of all chronological views',()=>{
 const a=event('Treaty','1905',['Japan']);const factor=eventFromFrontmatter({'timeline-kind':'factor','timeline-title':'Nationalism',timeline:['Japan']},'factor.md','Nationalism').event;
 const links=[{from:a.id,to:factor.id,relation:'contributed to'}];
 for(const mode of ['cards','vertical','wall','graph']){const d=dom();renderTimeline(d.root,[a,factor],{initialMode:mode,connections:links});if(mode==='graph'){assert.ok(d.label('Explore connections: Nationalism'));assert.ok(d.all().some(n=>n.textContent==='Abstract factor'));}else assert.equal(d.all().some(n=>n.attrs['aria-label']==='Select event: Nationalism'||n.attrs['aria-label']==='Open event: Nationalism'),false);}
});

test('wall periods reuse the nearest row when their year columns do not overlap',()=>{
 const period=(title,start,end)=>eventFromFrontmatter({'timeline-title':title,'timeline-date':start,'timeline-end':end,timeline:['A']},title+'.md',title).event;
 const d=dom();renderTimeline(d.root,[period('Early period','1800','1810'),period('Later period','1900','1910')],{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 const axis=Number(d.cls('ht-wall-axis')[0].style.gridRow);
 assert.deepEqual(d.cls('ht-wall-period').map(n=>Number(n.style.gridRow)),[axis-1,axis-1]);
 assert.equal(axis,2);
});

test('wall only lifts a period over point stacks in years that it spans',()=>{
 const range=eventFromFrontmatter({'timeline-title':'Period','timeline-date':'1900','timeline-end':'1910',timeline:['A']},'Period.md','Period').event;
 const items=[range,...Array.from({length:5},(_,i)=>event('Remote '+i,'1800',['A'])),event('Local','1905',['A'])];
 const d=dom();renderTimeline(d.root,items,{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 const axis=Number(d.cls('ht-wall-axis')[0].style.gridRow);
 assert.equal(Number(d.cls('ht-wall-period')[0].style.gridRow),axis-2);
 // Removing the overlapping point puts the period directly next to the axis,
 // even though the remote year still contains five events.
 const free=dom();renderTimeline(free.root,items.filter(e=>e.title!=='Local'),{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 assert.equal(Number(free.cls('ht-wall-period')[0].style.gridRow),Number(free.cls('ht-wall-axis')[0].style.gridRow)-1);
});

test('wall shared overlapping and touching periods appear once and stay separated',()=>{
 const period=(title,start,end)=>eventFromFrontmatter({'timeline-title':title,'timeline-date':start,'timeline-end':end,timeline:['A','B']},title+'.md',title).event;
 const d=dom();renderTimeline(d.root,[period('First','1900','1910'),period('Nested','1902','1905'),period('Touching','1910','1920'),period('Separate','1930','1940')],{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 const axis=Number(d.cls('ht-wall-axis')[0].style.gridRow);
 const rows=d.cls('ht-wall-period').map(n=>Number(n.style.gridRow));
 assert.deepEqual(rows,[axis-2,axis-1,axis-3,axis-1]);
});

test('wall century and BCE/CE ranges pack without moving or dropping endpoints',()=>{
 const cross=eventFromFrontmatter({'timeline-title':'Across eras','timeline-date':'5 BCE','timeline-end':'5 CE',timeline:['A']},'Cross.md','Cross').event;
 const d=dom();renderTimeline(d.root,[cross,event('Century','19th century',['A']),event('Decade','1920s',['A'])],{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 const axis=Number(d.cls('ht-wall-axis')[0].style.gridRow);
 assert.equal(d.cls('ht-wall-period').length,3);
 assert.ok(d.cls('ht-wall-period').every(n=>Number(n.style.gridRow)===axis-1));
 assert.deepEqual(d.cls('ht-wall-period').map(n=>n.style.gridColumn),['1 / 3','3 / 5','5 / 7']);
});

test('wall places a period 12px above three short titles using their measured height, and repacks on resize',()=>{
 const d=dom(), doc=d.root.ownerDocument, create=doc.createElement;
 let pointHeight=20, resized, disconnected=false, frames=[];
 doc.defaultView={
  requestAnimationFrame:callback=>{frames.push(callback);return frames.length;},cancelAnimationFrame(){},
  ResizeObserver:class {constructor(callback){resized=callback;}observe(){}disconnect(){disconnected=true;}}
 };
 doc.createElement=tag=>{
  const el=create(tag);
  el.getBoundingClientRect=()=>({width:parseFloat(el.style.width)||800,height:
   el.className.includes('ht-wall-stack') ? el.children.length*pointHeight+Math.max(0,el.children.length-1)*12 :
   el.className.includes('ht-wall-period') ? 38 : 20});
  return el;
 };
 const period=eventFromFrontmatter({'timeline-title':'Taisho Democracy','timeline-date':'1912','timeline-end':'1926',timeline:['A']},'Taisho.md','Taisho').event;
 const dispose=renderTimeline(d.root,[period,event('Five Power Treaty','1922',['A']),event('Japan withdrew from Russia','1922',['A']),event('Nine Power Treaty','1922',['A'])],{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 const span=d.cls('ht-wall-period')[0], stack=d.cls('ht-wall-above').find(n=>n.children.length===3), axis=d.cls('ht-wall-axis')[0];
 assert.ok(d.cls('ht-wall-measured').length);
 assert.equal(parseFloat(stack.style.top)-(parseFloat(span.style.top)+38),12);
 assert.equal(parseFloat(axis.style.top)-parseFloat(stack.style.top),22+84);
 assert.ok(parseFloat(d.cls('ht-wall-plot')[0].style.height)<240);
 pointHeight=40;resized();frames.shift()();
 assert.equal(parseFloat(stack.style.top)-(parseFloat(span.style.top)+38),12);
 assert.equal(parseFloat(axis.style.top)-parseFloat(stack.style.top),22+144);
 dispose();assert.equal(disconnected,true);
});

test('natural-height wall packing reuses gaps and respects actual overlapping boxes on either side',()=>{
 const {packWallItems}=require('../src/renderer');
 const entries=[
  {id:'remote',kind:'points',first:0,last:0,side:'above',height:300},
  {id:'short',kind:'points',first:2,last:2,side:'above',height:20},
  {id:'long',kind:'period',first:1,last:3,side:'above',height:38},
  {id:'local',kind:'period',first:1,last:1,side:'above',height:18},
  {id:'below',kind:'period',first:1,last:3,side:'below',height:38}
 ];
 const packed=packWallItems(entries), by=id=>packed.find(item=>item.id===id);
 assert.equal(by('long').offset,54); // one 20px title + 12px, not a 72px row
 assert.equal(by('local').offset,22); // reuse the gap under the long period
 assert.equal(by('below').offset,22);
 for(let i=0;i<packed.length;i++)for(let j=i+1;j<packed.length;j++){
  const a=packed[i],b=packed[j];
  if(a.side===b.side&&a.first<=b.last&&a.last>=b.first)
   assert.ok(a.offset+a.height+12<=b.offset||b.offset+b.height+12<=a.offset);
 }
});

test('wall shared nested periods retain the short-inside-long order without duplicates',()=>{
 const period=(title,start,end)=>eventFromFrontmatter({'timeline-title':title,'timeline-date':start,'timeline-end':end,timeline:['A','B']},title+'.md',title).event;
 const d=dom();renderTimeline(d.root,[event('Century','20th century',['A','B']),event('Decade','1920s',['A','B']),period('Year','1922-01','1922-12'),period('Two days','1922-06-01','1922-06-02')],{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 const axis=Number(d.cls('ht-wall-axis')[0].style.gridRow);
 for(const sign of [-1]){
  const distance=title=>Math.abs(Number(d.cls('ht-wall-period').find(n=>n.children[0].textContent===title&&(Number(n.style.gridRow)-axis)*sign>0).style.gridRow)-axis);
  assert.ok(distance('Century')>distance('Decade'));
  assert.ok(distance('Decade')>distance('Year'));
  assert.ok(distance('Year')>distance('Two days'));
 }
});

test('measured wall orders overlapping boxes by duration, not input order or displayed column span',()=>{
 const {packWallItems}=require('../src/renderer');
 for(const side of ['above','below']) {
  const packed=packWallItems([
   {id:'long',kind:'period',first:1,last:3,side,height:38,duration:30},
   {id:'medium',kind:'period',first:1,last:3,side,height:45,duration:10},
   {id:'short',kind:'period',first:1,last:3,side,height:20,duration:1},
   {id:'separate',kind:'period',first:5,last:6,side,height:38,duration:100}
  ]);
  const by=id=>packed.find(item=>item.id===id);
  assert.equal(by('short').offset,22);
  assert.equal(by('medium').offset,by('short').offset+20+12);
  assert.equal(by('long').offset,by('medium').offset+45+12);
  assert.equal(by('separate').offset,22);
 }
});

test('a longer wall period stays outside a shorter one raised by another year stack',()=>{
 const {packWallItems}=require('../src/renderer');
 const packed=packWallItems([
  {id:'tall',kind:'points',first:0,last:0,side:'above',height:200},
  {id:'long',kind:'period',first:1,last:4,side:'above',height:38,duration:30},
  {id:'short',kind:'period',first:0,last:1,side:'above',height:38,duration:2}
 ]);
 const by=id=>packed.find(item=>item.id===id);
 assert.equal(by('short').offset,234);
 assert.equal(by('long').offset,284);
});

test('saving or switching to Cause and Effect does not restore a Timeline-only selection as graph details',()=>{
 const items=[event('A','1900',['X']),event('B','1901',['X'])],connections=[{from:'A.md',to:'B.md',relation:'prompted'}];
 const d=dom();let state;
 renderTimeline(d.root,items,{initialMode:'vertical',initialSelected:'B.md',connections,onStateChange:value=>state=value});
 d.all().find(n=>n.tagName==='button'&&n.textContent==='Cause & Effect').events.click();
 assert.equal(d.cls('ht-detail-panel')[0].hidden,true);
 assert.equal(state.selected,'B.md');assert.equal(state.graphSelected,'');
 // Reproduce the refresh after another event is saved, including legacy state.
 renderTimeline(d.root,[...items,event('New event','1902',['X'])],{initialMode:'graph',initialSelected:state.selected,initialGraphSelected:state.graphSelected,connections});
 assert.equal(d.cls('ht-detail-panel')[0].hidden,true);
 assert.equal(d.cls('ht-detail-heading').length,0);
});

test('graph detail selection is explicit, independently retained, and can be closed without remounting the fishbone',()=>{
 const items=[event('A','1900',['X']),event('B','1901',['X'])],connections=[{from:'A.md',to:'B.md',relation:'prompted'}];
 const d=dom();let state;
 const render=()=>renderTimeline(d.root,items,{initialMode:'graph',initialSelected:'A.md',initialGraphSelected:state?.graphSelected,connections,onStateChange:value=>state=value});
 render();d.label('Explore connections: B').events.click();
 assert.equal(state.selected,'A.md');assert.equal(state.graphSelected,'B.md');
 render();assert.equal(d.cls('ht-detail-heading')[0].textContent,'B');
 const viewport=d.label('Fishbone: X');viewport.scrollLeft=123;
 d.all().find(n=>n.textContent==='Close details').events.click();
 assert.equal(d.cls('ht-detail-panel')[0].hidden,true);assert.equal(state.graphSelected,'');
 assert.equal(d.label('Fishbone: X'),viewport);assert.equal(viewport.scrollLeft,123);
 render();assert.equal(d.cls('ht-detail-panel')[0].hidden,true);
});

test('explicit navigation between Timeline and a saved fishbone keeps the same event and branch',()=>{
 const items=[event('A','1900',['X']),event('B','1901',['X'])],connections=[{from:'A.md',to:'B.md',relation:'led to'}];
 const analyses=[{id:'saved',title:'Topic',groups:['X'],causal:true,branches:[{title:'Politics',factors:[{eventId:'A.md'},{eventId:'B.md'}]}]}];
 const d=dom();renderTimeline(d.root,items,{initialMode:'vertical',initialSelected:'B.md',connections,analyses});
 d.all().find(n=>n.textContent==='Show in Cause & Effect').events.click();
 assert.equal(d.label('Saved fishbone analysis').value,'saved');assert.equal(d.cls('ht-fishbone-category').length,1);assert.equal(d.cls('ht-detail-heading')[0].textContent,'B');
 d.all().find(n=>n.textContent==='Show in Timeline').events.click();
 assert.equal(d.cls('ht-detail-heading')[0].textContent,'B');const target=d.label('Select event: B');assert.equal(target.attrs['aria-pressed'],'true');assert.equal(target.revealed,true);
});

test('wall refresh preserves both scrolling axes and the outer pane position',()=>{
 const d=dom();renderTimeline(d.root,data,{initialMode:'wall'});d.root.scrollTop=700;
 d.cls('ht-wall-scroll')[0].scrollTop=92;d.cls('ht-wall-scroll')[0].scrollLeft=1200;
 renderTimeline(d.root,[...data,event('New','1940',[])],{initialMode:'wall'});
 assert.equal(d.root.scrollTop,700);assert.equal(d.cls('ht-wall-scroll')[0].scrollTop,92);assert.equal(d.cls('ht-wall-scroll')[0].scrollLeft,1200);
});

test('newly saved dated events are revealed in Timeline and briefly marked in Chronicle only',()=>{
 const d=dom();renderTimeline(d.root,data,{initialMode:'cards',revealEvent:'Late.md'});
 const card=d.cls('ht-event-card').find(n=>n.attrs['data-event-id']==='Late.md');assert.equal(card.revealed,true);assert.ok(card.className.includes('ht-recent-event'));
 const v=dom();renderTimeline(v.root,data,{initialMode:'vertical',initialSelected:'Late.md',revealEvent:'Late.md'});
 assert.equal(v.cls('ht-detail-heading')[0].textContent,'Late');assert.equal(v.label('Select event: Late').revealed,true);
});

test('comparison reserves the inner rows for shared points and periods while keeping distinct events',()=>{
 const shared=event('Shared point','1900',['A','B']);
 const period=eventFromFrontmatter({'timeline-title':'Shared period','timeline-date':'1900','timeline-end':'1910',timeline:['A','B']},'Period.md','Period').event;
 const first={...event('Same name','1900',['A']),id:'first.md'},second={...event('Same name','1900',['B']),id:'second.md'};
 const d=dom();let opened;renderTimeline(d.root,[first,second,shared,period],{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B',onOpen:value=>opened=value});
 assert.equal(d.cls('ht-wall-title').length,4);assert.equal(d.cls('ht-wall-title').filter(n=>n.textContent==='Same name').length,2);
 assert.equal(d.cls('ht-wall-shared-label').length,2);
 const stacks=d.cls('ht-wall-above');const sharedStack=stacks.find(n=>n.attrs['aria-label'].includes('both timelines')),exclusive=stacks.find(n=>!n.attrs['aria-label'].includes('both timelines'));
 const axis=Number(d.cls('ht-wall-axis')[0].style.gridRow);
 assert.equal(sharedStack.style.gridRow,`${axis-1} / ${axis}`);
 assert.ok(Number(exclusive.style.gridRow.split(' / ')[1])<=Number(d.cls('ht-wall-period')[0].style.gridRow));
 d.cls('ht-wall-title').find(n=>n.textContent==='Shared point').events.click();assert.equal(opened,shared);
 d.label('Above the line').value='B';d.label('Above the line').events.change();d.label('Below the line').value='A';d.label('Below the line').events.change();
 assert.equal(d.cls('ht-wall-title').length,4);assert.equal(d.cls('ht-wall-shared-label').length,2);
 const check=d.cls('ht-compare-toggle')[0].children[0];check.checked=false;check.events.change();assert.equal(d.cls('ht-wall-title').length,4);assert.equal(d.cls('ht-wall-shared-label').length,0);
});

test('measured packing places shared periods before exclusive point stacks without overlap',()=>{
 const {packWallItems}=require('../src/renderer');
 for(const side of ['above','below']){
  const packed=packWallItems([
   {id:'exclusive-point',kind:'points',first:1,last:1,side,height:100},
   {id:'exclusive-period',kind:'period',first:0,last:1,side,height:40,duration:2},
   {id:'shared-period',kind:'period',shared:true,first:0,last:2,side,height:40,duration:20},
   {id:'shared-point',kind:'points',shared:true,first:0,last:0,side,height:25}
  ]);
  const by=id=>packed.find(item=>item.id===id);
  assert.equal(by('shared-point').offset,22);
  assert.equal(by('shared-period').offset,22+25+12);
  assert.ok(by('exclusive-point').offset>=by('shared-period').offset+40+12);
  assert.ok(by('exclusive-period').offset>=by('exclusive-point').offset+100+12);
 }
});

test('wall stacks run from early to late away from the axis with coarse dates after their detailed entries',()=>{
 const dates=[['Whole year','1933'],['February','1933-02'],['February day','1933-02-14'],['January','1933-01'],['January day','1933-01-30']];
 const items=dates.flatMap(([title,date])=>[event(title+' A',date,['A']),event(title+' B',date,['B'])]);
 const d=dom();renderTimeline(d.root,items,{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B'});
 const titles=stack=>stack.all().filter(n=>n.className==='ht-wall-title').map(n=>n.textContent);
 assert.deepEqual(titles(d.cls('ht-wall-above')[0]).reverse(),['January day A','January A','February day A','February A','Whole year A']);
 assert.deepEqual(titles(d.cls('ht-wall-below')[0]),['January day B','January B','February day B','February B','Whole year B']);
});

test('search scope isolates title and aliases, summary, and displayed or canonical dates and survives view switches',()=>{
 const a={...event('Incident','1937-07-07',['History']),aliases:['MPBI'],summary:'Bridge fighting'};
 const b={...event('Bridge','1940',['History']),summary:'MPBI analysis'};
 const d=dom();let state;renderTimeline(d.root,[a,b],{initialSearchScope:'title',onStateChange:value=>state=value});
 const query=d.label('Search historical events'),scope=d.label('Search in');
 const search=(value,where)=>{query.value=value;query.events.input();scope.value=where;scope.events.change();return d.cls('ht-event-title').map(n=>n.textContent);};
 search('MPBI','title');assert.equal(d.cls('ht-event-card').length,1);assert.equal(d.cls('ht-event-card')[0].attrs['data-event-id'],a.id);
 search('MPBI','summary');assert.equal(d.cls('ht-event-card').length,1);assert.equal(d.cls('ht-event-card')[0].attrs['data-event-id'],b.id);
 search('MPBI','all');assert.equal(d.cls('ht-event-card').length,2);
 for(const value of ['1937-07-07','7 Jul 1937']){search(value,'time');assert.equal(d.cls('ht-event-card').length,1);}
 search('Bridge','time');assert.equal(d.cls('ht-event-card').length,0);
 search('1937','time');d.all().find(n=>n.textContent==='Timeline'&&n.tagName==='button').events.click();assert.equal(d.cls('ht-vertical-item').length,1);assert.equal(state.searchScope,'time');
 d.all().find(n=>n.textContent==='Clear all filters').events.click();assert.equal(scope.value,'all');assert.equal(state.searchScope,'all');
});

test('article-free queries work in title and summary search while retaining ignore-case choice',()=>{
 const item={...event('End of war','1945',['History']),summary:'Agreement with country',aliases:['Peace']};
 const d=dom();renderTimeline(d.root,[item]);
 const input=d.label('Search historical events'),scope=d.label('Search in');
 for(const [where,query] of [['title','the end of the war'],['summary','an agreement with a country'],['title','the Peace'],['time','the 1945']]){
  scope.value=where;scope.events.change();input.value=query;input.events.input();assert.equal(d.cls('ht-event-card').length,1);
 }
 scope.value='title';scope.events.change();input.value='the unrelated';input.events.input();assert.equal(d.cls('ht-event-card').length,0);
});

test('event and view navigation are explicit history actions, unlike search, filters, and initial rendering',()=>{
 const d=dom(),changes=[];const cleanup=renderTimeline(d.root,data,{initialMode:'vertical',onStateChange:(state,change)=>changes.push({state,change})});
 assert.equal(changes.length,0);assert.equal(cleanup.getState().selected,'Early.md');
 const list=d.cls('ht-vertical-list')[0];list.scrollTop=180;
 d.label('Select event: Late').events.click();assert.equal(changes.at(-1).change.navigation,true);assert.equal(changes.at(-1).state.selected,'Late.md');
 assert.equal(d.cls('ht-vertical-list')[0],list);assert.equal(list.scrollTop,180);
 d.label('Search historical events').value='Late';d.label('Search historical events').events.input();assert.equal(changes.at(-1).change.navigation,false);
 d.all().find(n=>n.textContent==='Wall chart').events.click();assert.equal(changes.at(-1).change.navigation,true);
 d.all().find(n=>n.textContent==='Chronicle'&&n.tagName==='button').events.click();assert.equal(changes.at(-1).change.navigation,true);
 cleanup();
});

test('perspective search covers historian, interpretation and source, respects scope and case, and survives switching views',()=>{
 const items=[{...event('First','1900',['A']),perspectives:[{historian:'Figes',interpretation:'The economic pressures',source:'A People’s Tragedy'}]},
 {...event('Figes in title','1901',['A']),summary:'economic pressures'},event('Empty','1902',['A'])];
 const d=dom();let state;renderTimeline(d.root,items,{initialSearchScope:'perspectives',onStateChange:value=>state=value});
 const scope=d.label('Search in'),input=d.label('Search historical events');
 assert.equal(scope.value,'perspectives');
 for(const query of ['figes','the economic pressures','people’s tragedy']){
  input.value=query;input.events.input();assert.equal(d.cls('ht-event-card').length,1);assert.equal(d.cls('ht-event-card')[0].attrs['data-event-id'],'First.md');
 }
 input.value='figes';input.events.input();
 scope.value='all';scope.events.change();assert.equal(d.cls('ht-event-card').length,2);
 scope.value='perspectives';scope.events.change();
 d.all().find(n=>n.textContent==='Timeline'&&n.tagName==='button').events.click();assert.equal(d.cls('ht-vertical-item').length,1);assert.equal(state.searchScope,'perspectives');
 const caseFilter=d.label('Ignore case');caseFilter.checked=false;caseFilter.events.change();assert.equal(d.cls('ht-vertical-item').length,0);
 input.value='Figes';input.events.input();assert.equal(d.cls('ht-vertical-item').length,1);
});

test('search normalizes Unicode in event text and queries while preserving the case setting',()=>{
 const item={...event('ＡＢＣ Treaty','1945',['History']),summary:'Cafe\u0301 agreement'};
 const d=dom();renderTimeline(d.root,[item],{initialSearchScope:'title'});
 const input=d.label('Search historical events'),scope=d.label('Search in');
 for(const query of ['ABC','ＡＢＣ','abc']){input.value=query;input.events.input();assert.equal(d.cls('ht-event-card').length,1);}
 const ignore=d.label('Ignore case');ignore.checked=false;ignore.events.change();assert.equal(d.cls('ht-event-card').length,0);
 input.value='ABC';input.events.input();assert.equal(d.cls('ht-event-card').length,1);
 scope.value='summary';scope.events.change();input.value='Café';input.events.input();assert.equal(d.cls('ht-event-card').length,1);
});

test('mobile wall zoom keeps packing in layout pixels through resize, reset, and view cleanup',()=>{
 const d=mobileDom(),preferences=require('../src/chart-preferences').createChartPreferences(null);preferences.set('wall',2);
 const period=eventFromFrontmatter({'timeline-title':'Period','timeline-date':'1912','timeline-end':'1926',timeline:['A']},'Period.md','Period').event;
 const cleanup=renderTimeline(d.root,[period,event('First','1922',['A']),event('Second','1922',['A']),event('Third','1922',['A'])],{initialMode:'wall',initialCompare:true,initialAbove:'A',initialBelow:'B',chartPreferences:preferences});
 const plot=d.cls('ht-wall-plot')[0],span=d.cls('ht-wall-period')[0],stack=d.cls('ht-wall-above').find(n=>n.children.length===3),layer=d.cls('ht-chart-zoom-layer')[0],spacer=d.cls('ht-chart-zoom-spacer')[0];
 const original={height:plot.style.height,top:span.style.top,width:span.style.width,axis:d.cls('ht-wall-axis')[0].style.top};
 assert.equal(layer.style.transform,'scale(2)');assert.equal(parseFloat(spacer.style.width),parseFloat(plot.style.width)*2);
 assert.equal(parseFloat(stack.style.top)-parseFloat(span.style.top)-38,12);
 assert.equal(span.getBoundingClientRect().height,76);
 d.resize(plot);
 assert.deepEqual({height:plot.style.height,top:span.style.top,width:span.style.width,axis:d.cls('ht-wall-axis')[0].style.top},original);
 d.label('Reset chart zoom to 100%').events.click();d.flush();
 assert.equal(preferences.get('wall'),1);assert.equal(layer.style.transform,'scale(1)');assert.equal(d.cls('ht-wall-plot')[0],plot);
 assert.equal(plot.style.height,original.height);
 cleanup();assert.ok(d.observers.every(observer=>observer.disconnected));
});

test('mobile fishbone scales SVG and labels together without replacing selection/details',()=>{
 const d=mobileDom(),preferences=require('../src/chart-preferences').createChartPreferences(null);preferences.set('fishbone',1.5);
 const items=[event('A','1900',['X']),event('B','1901',['X'])];
 const cleanup=renderTimeline(d.root,items,{initialMode:'graph',chartPreferences:preferences,connections:[{from:'A.md',to:'B.md',relation:'prompted'}]});
 const canvas=d.cls('ht-fishbone-canvas')[0],layer=d.cls('ht-chart-zoom-layer')[0],a=d.label('Explore connections: A');
 assert.equal(canvas.parentElement,layer);assert.equal(layer.style.transform,'scale(1.5)');
 assert.ok(canvas.children.some(el=>el.tagName==='svg'));
 a.events.click();const detail=d.cls('ht-detail-panel')[0],heading=d.cls('ht-detail-heading')[0];
 d.label('Zoom chart in').events.click();d.flush();
 assert.equal(preferences.get('fishbone'),1.6);assert.equal(preferences.get('wall'),1);
 assert.equal(d.cls('ht-fishbone-canvas')[0],canvas);assert.equal(d.cls('ht-detail-panel')[0],detail);assert.equal(d.cls('ht-detail-heading')[0],heading);
 assert.equal(d.label('Explore connections: A'),a);assert.equal(heading.textContent,'A');
 const oldObservers=[...d.observers];d.all().find(el=>el.tagName==='button'&&el.textContent==='Timeline').events.click();
 assert.equal(d.cls('ht-chart-zoom-controls').length,0);assert.ok(oldObservers.every(observer=>observer.disconnected));
 assert.equal(cleanup.getState().selected,'A.md');cleanup();
});

test('mobile zoom survives full data refresh with chart scroll and device preference intact',()=>{
 const d=mobileDom(),preferences=require('../src/chart-preferences').createChartPreferences(null);preferences.set('wall',2);
 const options={initialMode:'wall',chartPreferences:preferences};
 let cleanup=renderTimeline(d.root,data,options);let scroll=d.cls('ht-wall-scroll')[0];scroll.scrollLeft=310;scroll.events.scroll();d.root.scrollTop=410;
 cleanup();cleanup=renderTimeline(d.root,[...data,event('Extra','1940',['A'])],options);scroll=d.cls('ht-wall-scroll')[0];
 assert.equal(scroll.scrollLeft,310);assert.equal(d.root.scrollTop,410);assert.equal(d.cls('ht-chart-zoom-layer')[0].style.transform,'scale(2)');
 cleanup();
});

test('desktop and non-chart views do not acquire mobile touch gestures or preference reads',()=>{
 for(const mode of ['cards','vertical','wall','graph']){
  const d=mobileDom();const options={initialMode:mode,connections:[{from:'Early.md',to:'Late.md'}]};
  if(['cards','vertical'].includes(mode))options.chartPreferences={get(){throw new Error('Non-chart preference read');}};
  const cleanup=renderTimeline(d.root,data,options);
  assert.equal(d.cls('ht-chart-zoom-controls').length,0);assert.equal(d.cls('ht-chart-zoom-viewport').length,0);cleanup();
 }
});


test('reading switch is opt-in, accessible, and stays outside diagram and history state',()=>{
 const desktop=dom();renderTimeline(desktop.root,data);assert.equal(desktop.cls('ht-reading-toggle').length,0);
 for(const readOnly of [true,false]){
  const d=dom();let changed,icon,history=0;
  const cleanup=renderTimeline(d.root,data,{readOnly,onReadOnlyChange:value=>changed=value,setIcon:(el,name)=>icon=name,onStateChange:()=>history++});
  const before=cleanup.getState(),toggle=d.cls('ht-reading-toggle')[0];
  assert.equal(toggle.attrs['aria-pressed'],String(readOnly));
  assert.equal(toggle.attrs['aria-label'],readOnly?'Switch to editing mode':'Switch to reading mode');
  assert.equal(icon,readOnly?'book-open':'pencil');
  toggle.events.click();assert.equal(changed,!readOnly);assert.deepEqual(cleanup.getState(),before);assert.equal(history,0);
  assert.equal(Object.hasOwn(before,'readOnly'),false);cleanup();
 }
});

test('reading mode hides mutation controls across all four views and retains browsing and search',()=>{
 const items=[event('Cause','1900',['X']),event('Effect','1901',['X'])];
 const connections=[{from:'Cause.md',to:'Effect.md',relation:'prompted'}];
 for(const mode of ['cards','vertical','wall','graph']){
  const d=dom();let edits=0,preview;
  const mutate=()=>edits++;
  const cleanup=renderTimeline(d.root,items,{initialMode:mode,readOnly:true,connections,onCreate:mutate,onEdit:mutate,onConnect:mutate,onAnalysisEdit:mutate,onOpen:mutate,onReadEvent:(item,render)=>preview={item,render}});
  const click=mode==='cards'?d.cls('ht-event-title')[0]:mode==='wall'?d.cls('ht-wall-title')[0]:mode==='vertical'?d.cls('ht-vertical-item')[0]:d.label('Explore connections: Cause');
  click.events.click();
  if(['cards','wall'].includes(mode)){assert.equal(preview.item.title,'Cause');const panel=d.root.ownerDocument.createElement('article');preview.render(panel);assert.ok(panel.all().some(el=>el.textContent==='Cause'));}
  else assert.equal(d.cls('ht-detail-heading')[0].textContent,'Cause');
  for(const label of ['Add event','Edit','Edit event','Add cause','Add consequence','Edit connection','New analysis','Edit analysis','Customize this fishbone']) assert.equal(d.all().some(el=>el.tagName==='button'&&el.textContent===label),false,label+' in '+mode);
  const query=d.label('Search historical events');query.value='Effect';query.events.input();assert.equal(cleanup.getState().query,'Effect');
  d.all().find(el=>el.tagName==='button'&&el.textContent==='Wall chart').events.click();
  assert.equal(cleanup.getState().mode,'wall');assert.equal(edits,0);cleanup();
 }
});

test('mobile read previews preserve the chart, zoom, and scroll and follow undated links without editors',()=>{
 const preferences=require('../src/chart-preferences').createChartPreferences(null);preferences.set('wall',1.6);
 const known={...event('Known','1931',['X']),perspectives:[{historian:'Historian',interpretation:'A perspective',source:'Book'}]};
 const unknown={...event('Undated','1900',['X']),start:null};
 for(const mode of ['cards','wall']){
  const d=mobileDom();let edited=0,opened=0,selected,renderPanel;
  const panel=d.root.ownerDocument.createElement('article');
  const cleanup=renderTimeline(d.root,[known,unknown],{initialMode:mode,readOnly:true,chartPreferences:preferences,connections:[{from:known.id,to:unknown.id}],onOpen:()=>edited++,onEdit:()=>edited++,onConnect:()=>edited++,onOpenNote:()=>opened++,onReadEvent:(item,render)=>{selected=item;renderPanel=render;panel.replaceChildren();render(panel);}});
  const nodes=d.all();d.root.scrollTop=260;
  const scroll=d.cls('ht-wall-scroll')[0];if(scroll){scroll.scrollLeft=150;scroll.events.scroll();}
  const title=d.cls(mode==='wall'?'ht-wall-title':'ht-event-title')[0];title.events.click();
  assert.equal(selected,known);assert.ok(panel.all().some(el=>el.textContent==='A perspective'));
  assert.equal(panel.all().some(el=>/^Show in /.test(el.textContent)),false);
  assert.deepEqual(d.all(),nodes);assert.equal(d.root.scrollTop,260);
  if(scroll){assert.equal(scroll.scrollLeft,150);assert.equal(d.cls('ht-chart-zoom-layer')[0].style.transform,'scale(1.6)');}
  panel.all().find(el=>el.className==='ht-connection-link').events.click();assert.equal(selected,unknown);
  assert.ok(panel.all().some(el=>el.className==='ht-detail-heading'&&el.textContent==='Undated'));
  panel.all().find(el=>el.tagName==='button'&&el.textContent==='Open note').events.click();assert.equal(opened,1);assert.equal(edited,0);
  cleanup();panel.replaceChildren();renderPanel(panel);assert.equal(panel.children.length,0);
 }
});

test('reading mode undated picker passes a browse callback and timeline undated links use native preview',()=>{
 const known=event('Known','1931',['X']),unknown={...event('Undated','1900',['X']),start:null};
 const d=dom();let choose,viewed,edits=0;
 const cleanup=renderTimeline(d.root,[known,unknown],{initialMode:'vertical',readOnly:true,connections:[{from:known.id,to:unknown.id}],onUndated:callback=>choose=callback,onReadEvent:item=>viewed=item,onEdit:()=>edits++,onOpen:()=>edits++});
 d.all().find(el=>el.textContent==='Undated events (1)').events.click();choose(unknown);assert.equal(viewed,unknown);
 viewed=null;d.cls('ht-connection-link')[0].events.click();assert.equal(viewed,unknown);assert.equal(edits,0);
 assert.equal(cleanup.getState().mode,'vertical');assert.equal(cleanup.getState().selected,known.id);cleanup();
});

test('saved analyses and empty timelines offer no creation or editing action in reading mode',()=>{
 const d=dom(),analyses=[{id:'a',title:'Outcome',groups:['X'],headEventId:'',branches:[{id:'b',title:'Politics',factors:[{id:'f',title:'Argument'}]}]}];
 renderTimeline(d.root,[],{readOnly:true,initialMode:'graph',analyses,onCreate(){throw Error('mutation');},onAnalysisEdit(){throw Error('mutation');}});
 assert.ok(d.label('Saved fishbone analysis'));assert.equal(d.all().some(el=>el.tagName==='button'&&/^(New|Edit|Customize)/.test(el.textContent)),false);
 const empty=dom();renderTimeline(empty.root,[],{readOnly:true,onCreate(){throw Error('mutation');}});
 assert.equal(empty.all().some(el=>el.tagName==='button'&&/^(Add event|Create your first event)$/.test(el.textContent)),false);
});

test('switching to reading mode immediately guards retained edit controls and disposed callbacks',()=>{
 const items=[event('Cause','1900',['X']),event('Effect','1901',['X'])];
 for(const mode of ['cards','vertical','graph']){
  const d=dom();let edits=0;const mutate=()=>edits++;
  const cleanup=renderTimeline(d.root,items,{initialMode:mode,readOnly:false,connections:[{from:'Cause.md',to:'Effect.md'}],onCreate:mutate,onEdit:mutate,onConnect:mutate,onAnalysisEdit:mutate,onReadOnlyChange(){}});
  if(mode==='graph')d.label('Explore connections: Cause').events.click();
  const controls=d.all().filter(el=>el.tagName==='button'&&/^(Add event|Edit|Edit event|Add cause|Add consequence|Edit connection|New analysis|Customize this fishbone)$/.test(el.textContent));assert.ok(controls.length);
  d.label('Switch to reading mode').events.click();controls.forEach(el=>el.events.click());assert.equal(edits,0);
  cleanup();controls.forEach(el=>el.events.click());assert.equal(edits,0);
 }
});


test('renderer teardown retires its latest native preview after following a linked event',()=>{
 const d=dom(),items=[event('Cause','1900',['X']),event('Effect','1901',['X'])];
 const panel=d.root.ownerDocument.createElement('article');const closed=[];let presentations=0;
 const cleanup=renderTimeline(d.root,items,{readOnly:true,connections:[{from:'Cause.md',to:'Effect.md'}],onReadEvent:(item,render)=>{
  const presentation=presentations++;panel.replaceChildren();render(panel);return()=>closed.push(presentation);
 }});
 d.cls('ht-event-title')[0].events.click();assert.equal(presentations,1);assert.deepEqual(closed,[]);
 panel.all().find(el=>el.className==='ht-connection-link').events.click();assert.equal(presentations,2);assert.deepEqual(closed,[]);
 assert.ok(panel.all().some(el=>el.className==='ht-detail-heading'&&el.textContent==='Effect'));
 const staleLink=panel.all().find(el=>el.className==='ht-connection-link');
 cleanup();assert.deepEqual(closed,[1]);staleLink.events.click();assert.equal(presentations,2);
 cleanup();assert.deepEqual(closed,[1]);
 // Older hosts may not return a preview disposer.
 const older=dom(),dispose=renderTimeline(older.root,items,{readOnly:true,onReadEvent(){}});
 older.cls('ht-event-title')[0].events.click();assert.doesNotThrow(dispose);
});
