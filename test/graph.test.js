 'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildFishbones,layoutFishbone}=require('../src/graph');
const event=(id,category='Politics')=>({id,title:id,category,start:{year:1900}});
test('fishbones preserve cause direction, categories, and connection evidence without inventing transitive causes',()=>{
 const events=[event('A','Economics'),event('B'),event('C'),event('Orphan'),{id:'undated'}];
 const links=[{from:'A',to:'B',relation:'prompted',source:'Book',disputed:true},{from:'B',to:'C',relation:'enabled'},{from:'undated',to:'C'},{from:'missing',to:'C'}];
 const diagrams=buildFishbones(events,links);assert.equal(diagrams.length,2);assert.equal(diagrams[0].outcome.id,'B');assert.equal(diagrams[0].branches[0].category,'Economics');assert.equal(diagrams[0].branches[0].causes[0].link,links[0]);
 assert.equal(diagrams[1].branches[0].causes[0].event.id,'B');assert.equal(diagrams[1].branches[0].causes.length,1);
 assert.equal(buildFishbones(events,[{from:'C',to:'C'}]).length,0);assert.deepEqual(buildFishbones([],links),[]);
});
test('fishbones support cycles and multiple relationships without recursion or dropped evidence',()=>{
 const diagrams=buildFishbones([event('A'),event('B')],[{from:'A',to:'B',relation:'influenced'},{from:'A',to:'B',relation:'enabled'},{from:'B',to:'A',relation:'response'}]);
 assert.equal(diagrams.length,2);assert.equal(diagrams[1].branches[0].causes.length,2);
});
test('fishbone geometry accommodates many branches and readable multiline cause labels',()=>{
 const events=[event('Outcome'),...Array.from({length:45},(_,i)=>event('Cause '+i,'Category '+i%7))];
 const [diagram]=buildFishbones(events,events.slice(1).map(event=>({from:event.id,to:'Outcome',relation:'contributed to'})));
 const layout=layoutFishbone(diagram);assert.ok(layout.headX>Math.max(...layout.branches.map(branch=>branch.baseX)));
 let count=0;for(const branch of layout.branches){for(let i=0;i<branch.causes.length;i++){
  const cause=branch.causes[i];count++;assert.ok(cause.y-38>=0&&cause.y+55<layout.height);assert.ok(cause.x+176<cause.joinX);
  if(i)assert.ok(Math.abs(cause.y-branch.causes[i-1].y)>=100);
 }}assert.equal(count,45);
});

test('analysis heads and factors may be abstract, undated, attached, or temporarily missing',()=>{
 const {buildAnalysisFishbone}=require('../src/graph');const undated={id:'u',title:'An undated event'};
 const analysis={id:'a',title:'Why expansion?',headEventId:'',branches:[{title:'Economic arguments',factors:[{title:'Self-sufficiency',eventId:'u',role:'Enabling factor',explanation:'Mechanism',source:'Book',disputed:true},{title:'Preserved argument',eventId:'gone'}]}]};
 const diagram=buildAnalysisFishbone(analysis,[undated]);assert.equal(diagram.outcome.title,'Why expansion?');assert.equal(diagram.outcome.start,undefined);
 assert.equal(diagram.branches[0].causes[0].event.backingEvent,undated);assert.equal(diagram.branches[0].causes[0].link.disputed,true);assert.equal(diagram.branches[0].causes[1].event.title,'Preserved argument');assert.equal(diagram.branches[0].causes[1].event.backingEvent,undefined);
});

test('category branches include both causes and effects without inventing links or showing orphans',()=>{
 const {buildTimelineFishbone}=require('../src/graph');const events=[event('Crash','Economics'),event('Tariff','Economics'),event('War','Politics'),event('Treaty','Politics'),event('Orphan')];
 const links=[{from:'Crash',to:'Tariff',relation:'prompted',disputed:true,source:'Book'},{from:'War',to:'Treaty',relation:'led to'},{from:'missing',to:'Treaty'}];
 const diagram=buildTimelineFishbone(events,links,'Japanese expansion');assert.equal(diagram.outcome.title,'Japanese expansion');assert.deepEqual(diagram.branches.map(branch=>branch.category),['Economics','Politics']);
 assert.deepEqual(diagram.branches[0].causes.map(cause=>cause.event.id),['Crash','Tariff']);assert.equal(diagram.links.length,2);assert.deepEqual(diagram.links[0],links[0]);assert.ok(!diagram.branches.some(branch=>branch.outcome));
 const layout=layoutFishbone(diagram);for(const branch of layout.branches){assert.ok(Math.abs(branch.causes[1].y-layout.axisY)<Math.abs(branch.causes[0].y-layout.axisY));}
 assert.equal(buildTimelineFishbone(events,[],'Empty'),null);
});
test('causal ordering handles forks, merges, cross-category links and cycles deterministically',()=>{
 const {buildTimelineFishbone,causalRanks}=require('../src/graph');const events=[event('A','Economics'),event('B','Politics'),event('C','Economics'),event('D','Politics')];
 const links=[{from:'A',to:'B'},{from:'A',to:'C'},{from:'B',to:'D'},{from:'C',to:'D'}];
 const diagram=buildTimelineFishbone(events,links,'Topic'),layout=layoutFishbone(diagram),positions=new Map(layout.branches.flatMap(branch=>branch.causes.map(cause=>[cause.event.id,cause])));
 for(const branch of layout.branches)assert.ok(Math.abs(branch.causes[0].y-layout.axisY)>Math.abs(branch.causes[1].y-layout.axisY));
 assert.equal(layout.branches.length,links.length);
 const ranks=causalRanks(events,[...links,{from:'D',to:'B'}]);assert.equal(ranks.get('B').cycle,true);assert.equal(ranks.get('D').cycle,true);assert.equal(ranks.get('A').cycle,false);assert.ok(ranks.get('B').rank>ranks.get('A').rank);
});
test('large causal chains avoid recursive traversal limits',()=>{
 const {causalRanks}=require('../src/graph');const events=Array.from({length:6000},(_,i)=>({id:String(i)})),links=events.slice(1).map((event,i)=>({from:String(i),to:event.id}));
 assert.equal(causalRanks(events,links).get('5999').rank,5999);
});
test('customized category fishbones preserve causal arrows between attached factors',()=>{
 const {buildAnalysisFishbone}=require('../src/graph');const events=[event('A','Economics'),event('B','Economics')];const diagram=buildAnalysisFishbone({id:'saved',title:'Broad outcome',causal:true,branches:[{title:'Economic factors',factors:[{title:'B explained',eventId:'B'},{title:'A explained',eventId:'A'}]}]},events,[{from:'A',to:'B',relation:'enabled',source:'Source'}]);
 assert.equal(diagram.causal,true);assert.equal(diagram.links.length,1);assert.equal(diagram.branches[0].causes[0].event.title,'A explained');assert.equal(diagram.links[0].source,'Source');
});

test('independent pairs repeat categories without crossing lanes and keep shared outcomes explicit',()=>{
 const {buildTimelineFishbone}=require('../src/graph');const events=[event('War 1'),event('Treaty 1'),event('War 2'),event('Treaty 2'),event('Crash','Economics'),event('Tariff','Economics')];
 const links=[{from:'War 1',to:'Treaty 1',relation:'led to'},{from:'War 2',to:'Treaty 2',relation:'led to'},{from:'Crash',to:'Tariff',relation:'prompted'},{from:'War 1',to:'Treaty 2',relation:'contributed to'}];
 const diagram=buildTimelineFishbone(events,links,'Expansion'),layout=layoutFishbone(diagram);assert.deepEqual(diagram.branches.map(branch=>branch.category),['Politics','Politics','Economics','Politics']);assert.equal(diagram.branches.length,4);
 assert.equal(diagram.branches[0].side,diagram.branches[1].side);assert.notEqual(diagram.branches[0].column,diagram.branches[1].column);assert.notEqual(diagram.branches[0].side,diagram.branches[2].side);
 for(const branch of layout.branches){assert.equal(branch.causes.length,2);assert.equal(branch.link.from,branch.causes[0].event.id);assert.equal(branch.link.to,branch.causes[1].event.id);assert.ok(Math.abs(branch.causes[0].y-layout.axisY)>Math.abs(branch.causes[1].y-layout.axisY));}
});
test('an abstract outcome needs no date to appear in a causal pair',()=>{
 const {buildTimelineFishbone}=require('../src/graph');const factor={id:'nationalism',title:'Nationalism becomes dominant',kind:'factor',start:null,category:'Politics'};
 const diagram=buildTimelineFishbone([event('Treaty'),factor,{id:'unknown',start:null}], [{from:'Treaty',to:'nationalism',relation:'contributed to'},{from:'Treaty',to:'unknown',relation:'led to'}],'Japan');
 assert.equal(diagram.branches.length,1);assert.equal(diagram.branches[0].causes[1].event,factor);
});

test('saved analysis retains a complete causal chain and an unattached argument on one branch',()=>{
 const {buildAnalysisFishbone}=require('../src/graph');
 const events=[event('Mukden'),event('Lytton'),event('League'),event('Outside')];
 const analysis={id:'saved',title:'Japan',causal:true,branches:[{title:'Politics',factors:[{eventId:'League'},{eventId:'Lytton'},{eventId:'Mukden'},{title:'Abstract argument'}]}]};
 const diagram=buildAnalysisFishbone(analysis,events,[{from:'Mukden',to:'Lytton',relation:'led to'},{from:'Lytton',to:'League',relation:'undermined'},{from:'League',to:'Outside',relation:'prompted'}]);
 assert.equal(diagram.branches.length,1);assert.equal(diagram.branches[0].causes.length,4);assert.equal(diagram.links.length,2);
 assert.equal(diagram.branches[0].causes.at(-1).event.title,'Abstract argument');
 assert.equal(diagram.branches[0].links.length,2);assert.equal(diagram.branches[0].causes.filter(c=>c.event.attachedId==='Lytton').length,1);
 const layout=layoutFishbone(diagram),branch=layout.branches[0],distance=id=>Math.abs(branch.causes.find(c=>c.event.attachedId===id).y-layout.axisY);
 assert.ok(distance('Mukden')>distance('Lytton'));assert.ok(distance('Lytton')>distance('League'));
 assert.ok(Number.isFinite(layout.height));assert.equal(analysis.branches[0].factors[0].eventId,'League');
});

test('saved branch identities survive cross-branch links and cycles without moving factors',()=>{
 const {buildAnalysisFishbone}=require('../src/graph');const events=[event('A'),event('B'),event('C')];
 const analysis={id:'x',title:'Topic',causal:true,branches:[{title:'First',factors:[{eventId:'A'},{eventId:'B'}]},{title:'Second',factors:[{eventId:'C'}]}]};
 const diagram=buildAnalysisFishbone(analysis,events,[{from:'A',to:'B'},{from:'B',to:'A'},{from:'B',to:'C'}]);
 assert.equal(diagram.branches.length,2);assert.deepEqual(diagram.branches[0].causes.map(c=>c.event.attachedId),['A','B']);assert.equal(diagram.branches[1].causes[0].event.attachedId,'C');assert.equal(diagram.links.length,3);assert.equal(diagram.branches[0].links.length,2);assert.equal(diagram.branches[0].causes[0].cycle,true);
});
