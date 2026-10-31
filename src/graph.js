'use strict';

const { mountChartZoom } = require('./chart-zoom');

// Each outcome gets a fishbone of its explicit, saved incoming connections.
// Separate diagrams preserve A → B → C without inventing an A → C connection.
function buildFishbones(events, connections) {
  const dated = events.filter(event => event.start);
  const byId = new Map(dated.map(event => [event.id, event]));
  const incoming = new Map();
  for (const link of connections) {
    if (link.from === link.to || !byId.has(link.from) || !byId.has(link.to)) continue;
    if (!incoming.has(link.to)) incoming.set(link.to, []);
    incoming.get(link.to).push({ event: byId.get(link.from), link });
  }
  return dated.filter(event => incoming.has(event.id)).map(outcome => {
    const groups = new Map();
    for (const cause of incoming.get(outcome.id)) {
      const category = cause.event.category && cause.event.category !== 'Uncategorized' ? cause.event.category : 'Other causes';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(cause);
    }
    return { outcome, branches: [...groups].map(([category, causes]) => ({ category, causes })) };
  });
}

// Condense cycles before ordering so only explicit causal precedence affects placement.
// Iterative traversals avoid recursion limits on large imported event libraries.
function causalRanks(events, links) {
  const ids=events.map(event=>event.id),known=new Set(ids);
  const forward=new Map(ids.map(id=>[id,[]])),reverse=new Map(ids.map(id=>[id,[]]));
  for(const link of links)if(known.has(link.from)&&known.has(link.to)&&link.from!==link.to){forward.get(link.from).push(link.to);reverse.get(link.to).push(link.from);}
  const visited=new Set(),finished=[];
  for(const root of ids){
    if(visited.has(root))continue;visited.add(root);const stack=[[root,0]];
    while(stack.length){const frame=stack[stack.length-1],next=forward.get(frame[0]);if(frame[1]<next.length){const id=next[frame[1]++];if(!visited.has(id)){visited.add(id);stack.push([id,0]);}}else{finished.push(frame[0]);stack.pop();}}
  }
  const component=new Map(),members=[];
  for(const root of finished.reverse()){
    if(component.has(root))continue;const index=members.length,list=[],stack=[root];component.set(root,index);
    while(stack.length){const id=stack.pop();list.push(id);for(const parent of reverse.get(id))if(!component.has(parent)){component.set(parent,index);stack.push(parent);}}
    members.push(list);
  }
  const next=members.map(()=>new Set()),incoming=members.map(()=>0),ranks=members.map(()=>0);
  for(const link of links){const a=component.get(link.from),b=component.get(link.to);if(a===undefined||b===undefined||a===b||next[a].has(b))continue;next[a].add(b);incoming[b]++;}
  const queue=incoming.flatMap((count,i)=>count?[]:[i]);
  for(let i=0;i<queue.length;i++){const current=queue[i];for(const child of next[current]){ranks[child]=Math.max(ranks[child],ranks[current]+1);if(--incoming[child]===0)queue.push(child);}}
  return new Map(ids.map(id=>[id,{rank:ranks[component.get(id)],cycle:members[component.get(id)].length>1}]));
}

// Keep each explicit cause → effect pair on an independent diagonal.
// Repeated categories and repeated events are intentional: they keep links local.
function pairFishbone(diagram, connections) {
  const entries=diagram.branches.flatMap(branch=>branch.causes.map(cause=>({branch,cause,ref:cause.event.analytical?cause.event.attachedId:cause.event.id})));
  const refs=new Map();for(const entry of entries)if(entry.ref){if(!refs.has(entry.ref))refs.set(entry.ref,[]);refs.get(entry.ref).push(entry);}
  const links=connections.filter(link=>link.from!==link.to&&refs.has(link.from)&&refs.has(link.to));
  const ranks=causalRanks([...refs.keys()].map(id=>({id})),links),used=new Set(),branches=[];
  for(const original of links){
    const sources=refs.get(original.from),targets=refs.get(original.to);
    const from=sources.find(source=>targets.some(target=>target.branch===source.branch))||sources[0];
    const to=targets.find(target=>target.branch===from.branch)||targets[0];
    used.add(from.cause);used.add(to.cause);
    const category=from.branch.category===to.branch.category?from.branch.category:from.branch.category+' → '+to.branch.category;
    const link={...original,from:from.cause.event.id,to:to.cause.event.id};
    branches.push({category,link,causes:[{...from.cause,slot:0,cycle:ranks.get(original.from).cycle},{...to.cause,slot:1,cycle:ranks.get(original.to).cycle}]});
  }
  // Freeform analysis factors and missing attachments remain visible without arrows.
  for(const entry of entries)if(!used.has(entry.cause))branches.push({category:entry.branch.category,causes:[{...entry.cause,slot:0}]});
  const categories=new Map(),columns=[0,0];
  for(const branch of branches){if(!categories.has(branch.category))categories.set(branch.category,categories.size%2);branch.side=categories.get(branch.category);branch.column=columns[branch.side]++;}
  return {...diagram,branches,causal:true,paired:true,combined:true,slots:2,links:branches.filter(branch=>branch.link).map(branch=>branch.link)};
}

// The overview only includes events with a visible saved relationship.
function buildTimelineFishbone(events, connections, title) {
  const byId=new Map(events.filter(event=>event.start||event.kind==='factor').map(event=>[event.id,event]));
  const links=connections.filter(link=>link.from!==link.to&&byId.has(link.from)&&byId.has(link.to));
  if(!links.length)return null;
  const connected=new Set(links.flatMap(link=>[link.from,link.to])),groups=new Map();
  for(const event of byId.values()){
    if(!connected.has(event.id))continue;
    const category=event.category&&event.category!=='Uncategorized'?event.category:'Other factors';
    if(!groups.has(category))groups.set(category,{category,causes:[]});groups.get(category).causes.push({event});
  }
  return pairFishbone({outcome:{id:'timeline-overview',title,analytical:true,analysisHead:true,timelineHead:true},branches:[...groups.values()]},links);
}

// Analytical factors are diagram-local arguments, not invented historical events.
function buildAnalysisFishbone(analysis, events, connections = []) {
  const byId = new Map(events.map(event => [event.id,event]));
  const item = (title,eventId,id,extra={}) => ({id,title,start:byId.get(eventId)?.start,backingEvent:byId.get(eventId),attachedId:eventId,analytical:true,...extra});
  const diagram = {
    outcome:item(analysis.title,analysis.headEventId,analysis.id,{analysisHead:true}),
    combined:(analysis.branches || []).some(branch=>byId.has(branch.eventId)),
    branches:(analysis.branches || []).map((branch,i)=>({category:branch.title,outcome:analysis.causal?undefined:byId.get(branch.eventId),causes:(branch.factors || []).map((factor,j)=>({
      event:item(factor.title || byId.get(factor.eventId)?.title || 'Unavailable event',factor.eventId,analysis.id+':'+i+':'+j,{factor}),
      link:{relation:factor.role || 'Contributing factor',explanation:factor.explanation,source:factor.source,disputed:factor.disputed}
    }))}))
  };
  if(!analysis.causal)return diagram;
  // Saved analyses own their branch membership. Only the automatic overview
  // splits connections into pairs; never split or duplicate the user's factors.
  const refs=new Map();
  for(const branch of diagram.branches) for(const cause of branch.causes) {
    const id=cause.event.attachedId;
    if(id){if(!refs.has(id))refs.set(id,[]);refs.get(id).push({branch,cause});}
  }
  const links=[];
  for(const original of connections){
    if(original.from===original.to||!refs.has(original.from)||!refs.has(original.to))continue;
    const sources=refs.get(original.from),targets=refs.get(original.to);
    const same=sources.flatMap(from=>targets.filter(to=>to.branch===from.branch).map(to=>({from,to})));
    for(const {from,to} of same.length?same:[{from:sources[0],to:targets[0]}]){
      const link={...original,from:from.cause.event.id,to:to.cause.event.id};links.push(link);
      if(from.branch===to.branch)(from.branch.links ||= []).push(link);
    }
  }
  for(const branch of diagram.branches){
    const ranks=causalRanks(branch.causes.map(cause=>cause.event),branch.links||[]);
    const connected=new Set((branch.links||[]).flatMap(link=>[link.from,link.to]));
    const ordered=branch.causes.filter(cause=>connected.has(cause.event.id)).sort((a,b)=>ranks.get(a.event.id).rank-ranks.get(b.event.id).rank);
    let next=0;
    branch.causes=branch.causes.map(cause=>connected.has(cause.event.id)?ordered[next++]:cause);
    branch.causes.forEach((cause,slot)=>{cause.slot=slot;cause.cycle=ranks.get(cause.event.id).cycle;});
  }
  return {...diagram,causal:true,combined:true,links};

}

// Fixed geometry leaves room for multiline event names and relationship labels.
function layoutFishbone(diagram) {
  const columns = diagram.paired?Math.max(1,...diagram.branches.map(branch=>branch.column+1)):Math.ceil(diagram.branches.length / 2);
  const rowHeight=108;
  const edgePadding=diagram.combined?84:30;
  const columnWidth=410;
  const branchHeight = branch => 104 + branch.causes.length * rowHeight;
  const top = Math.max(120, ...diagram.branches.filter((branch, i) => diagram.paired?branch.side===0:i%2===0).map(branchHeight));
  const bottom = Math.max(120, ...diagram.branches.filter((branch, i) => diagram.paired?branch.side===1:i%2===1).map(branchHeight));
  const width = Math.max(840, columns * columnWidth + 330), height = top + bottom + edgePadding * 2;
  const axisY = top + edgePadding, headX = width - 270;
  const branches = diagram.branches.map((branch, index) => {
    const upper = diagram.paired?branch.side===0:index%2===0, direction = upper ? -1 : 1;
    const x = 40 + (diagram.paired?branch.column:Math.floor(index / 2)) * columnWidth, tipX = x + 190, baseX = x + 340;
    const length = branchHeight(branch), tipY = axisY + direction * length;
    const causes = branch.causes.map((cause, i) => {
      const y = tipY - direction * (70 + (diagram.causal?cause.slot:i) * rowHeight);
      const joinX = tipX + (baseX - tipX) * (1 - Math.abs(y - axisY) / length);
      return { ...cause, x, y, joinX };
    });
    return { ...branch, upper, tipX, tipY, baseX, causes };
  });
  return { width, height, axisY, headX, branches };
}

function mountFishbones(host, events, connections, options = {}) {
  const doc = host.ownerDocument;
  const make = (tag, cls, text) => { const el=doc.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el; };
  const svgEl = (tag, attrs = {}) => { const el=doc.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));return el; };
  const diagrams = options.diagrams || buildFishbones(events, connections);
  if (!diagrams.length) {
    host.append(make('p','ht-empty','No connected outcomes in this timeline. Add a cause or consequence from an event’s details.'));
    return () => {};
  }
  const toolbar=make('div','ht-fishbone-toolbar');
  const label=make('label','ht-field');label.append(make('span','ht-field-label','Outcome'));
  const select=make('select','ht-select');select.setAttribute('aria-label','Fishbone outcome');
  const all=make('option','','All outcomes in this timeline');all.value='';select.append(all);
  for(const diagram of diagrams){const item=make('option','',diagram.outcome.title);item.value=diagram.outcome.id;select.append(item);}
  select.value='';label.append(select);toolbar.append(label);if(!options.diagrams)host.append(toolbar);
  const list=make('div','ht-fishbone-list');host.append(list);
  const cards=[], zoomControllers=[];
  const eventButton=(event, cls, prefix)=>{
    const button=make('button',cls);button.type='button';button.setAttribute('aria-label',prefix+event.title);
    button.title=event.title+' · '+options.dateLabel(event);
    button.append(make('strong','',event.title),make('span','ht-fishbone-date',options.dateLabel(event)));
    if(event.important)button.classList.add('ht-important');
    button.addEventListener('click',()=>options.onSelect(event));
    return button;
  };
  for(const diagram of diagrams){
    const geometry=layoutFishbone(diagram);
    const card=make('section','ht-fishbone-card');card.setAttribute('aria-label','Causes of '+diagram.outcome.title);
    card.append(make('h3','ht-fishbone-heading',diagram.outcome.title));
    const scroll=make('div','ht-fishbone-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Fishbone: '+diagram.outcome.title);
    const canvas=make('div','ht-fishbone-canvas');canvas.style.width=geometry.width+'px';canvas.style.height=geometry.height+'px';
    const svg=svgEl('svg',{width:geometry.width,height:geometry.height,'aria-hidden':'true',class:'ht-fishbone-lines'});
    const line=(x1,y1,x2,y2,cls)=>{const el=svgEl('line',{x1,y1,x2,y2,class:cls});svg.append(el);return el;};
    line(26,geometry.axisY,geometry.headX-12,geometry.axisY,'ht-fishbone-spine');
    const arrow=svgEl('path',{d:`M ${geometry.headX-23} ${geometry.axisY-6} L ${geometry.headX-12} ${geometry.axisY} L ${geometry.headX-23} ${geometry.axisY+6}`,class:'ht-fishbone-spine',fill:'none'});svg.append(arrow);canvas.append(svg);
    for(const branch of geometry.branches){
      line(branch.tipX,branch.tipY,branch.baseX,geometry.axisY,diagram.causal?'ht-fishbone-grouping':'ht-fishbone-bone');
      const category=make(branch.outcome?'button':'div','ht-fishbone-category'+(branch.outcome?' ht-fishbone-branch-outcome':''),branch.category);
      category.title=branch.category;
      if(branch.outcome){category.type='button';category.setAttribute('aria-label','Explore branch outcome: '+branch.outcome.title);category.addEventListener('click',()=>options.onSelect(branch.outcome));}
      category.style.left=(branch.tipX-(branch.outcome?140:90))+'px';category.style.top=(branch.upper?branch.tipY-(branch.outcome?64:20):branch.tipY+4)+'px';canvas.append(category);
      for(const cause of branch.causes){
        const rib=line(cause.x+178,cause.y,cause.joinX,cause.y,'ht-fishbone-rib');
        if(cause.link?.disputed&&!diagram.causal)rib.setAttribute('stroke-dasharray','5 4');
        const causeBox=make('div','ht-fishbone-cause');causeBox.style.left=cause.x+'px';causeBox.style.top=(cause.y-38)+'px';
        causeBox.append(eventButton(cause.event,'ht-fishbone-event','Explore connections: '));
        if(!diagram.causal){
          const relation=make('span','ht-fishbone-relation',cause.link.relation+(cause.link.disputed?' · disputed':''));
          relation.title=[cause.link.explanation,cause.link.source].filter(Boolean).join('\n');causeBox.append(relation);
        }else if(cause.cycle)causeBox.append(make('span','ht-fishbone-relation','Feedback cycle'));
        canvas.append(causeBox);
      }
    }
    if(diagram.causal){
      for(const branch of geometry.branches){
        for(const link of branch.links || (branch.link?[branch.link]:[])){
          const from=branch.causes.find(cause=>cause.event.id===link.from),to=branch.causes.find(cause=>cause.event.id===link.to);
          if(!from||!to)continue;
          const dx=to.joinX-from.joinX,dy=to.y-from.y,length=Math.hypot(dx,dy),ux=dx/length,uy=dy/length;
          const sx=from.joinX+ux*5,sy=from.y+uy*5,tx=to.joinX-ux*6,ty=to.y-uy*6;
          const curved=Math.abs(from.slot-to.slot)>1||to.slot<from.slot;
          const bend=Math.max(from.joinX,to.joinX)+44;
          const endX=curved?to.joinX+6:tx,endY=curved?to.y:ty;
          const path=svgEl('path',{d:curved?`M ${from.joinX+5} ${from.y} C ${bend} ${from.y}, ${bend} ${to.y}, ${endX} ${endY}`:`M ${sx} ${sy} L ${tx} ${ty}`,class:'ht-fishbone-causal-arrow',fill:'none','data-from':link.from,'data-to':link.to});
          if(link.disputed)path.setAttribute('stroke-dasharray','5 4');svg.append(path);
          const ax=curved?-1:ux,ay=curved?0:uy;
          svg.append(svgEl('path',{d:`M ${endX-ax*9-ay*5} ${endY-ay*9+ax*5} L ${endX} ${endY} L ${endX-ax*9+ay*5} ${endY-ay*9-ax*5}`,class:'ht-fishbone-causal-arrow',fill:'none'}));
          const relation=make('span','ht-fishbone-pair-relation',link.relation+(link.disputed?' · disputed':''));
          relation.title=[link.explanation,link.source].filter(Boolean).join('\n');
          relation.style.left=((curved?bend:Math.max(from.joinX,to.joinX))+12)+'px';relation.style.top=((from.y+to.y)/2-14)+'px';canvas.append(relation);
        }
        for(const cause of branch.causes)svg.append(svgEl('circle',{cx:cause.joinX,cy:cause.y,r:3,class:'ht-fishbone-event-anchor'}));
      }
    }
    const head=eventButton(diagram.outcome,'ht-fishbone-effect','Explore connections: ');
    head.style.left=geometry.headX+'px';head.style.top=(geometry.axisY-48)+'px';
    canvas.append(head);scroll.append(canvas);card.append(scroll);
    if(diagram.causal){
      const key=make('p','ht-fishbone-key',diagram.paired?'Each diagonal holds one saved cause → effect pair. Categories and shared events may repeat so connections stay separate.':'Each diagonal matches one branch in your analysis. Arrows show saved relationships within it; cross-branch relationships are listed in Connections below. Grouping alone does not create a causal link.');card.append(key);
      const evidence=make('details','ht-fishbone-evidence');evidence.append(make('summary','','Connections ('+diagram.links.length+')'));
      const byId=new Map(diagram.branches.flatMap(branch=>branch.causes.map(cause=>[cause.event.id,cause.event])));
      for(const link of diagram.links){
        const row=make('div','ht-fishbone-evidence-row');
        row.append(eventButton(byId.get(link.from),'ht-fishbone-evidence-event','Explore cause: '),make('span','', '— '+link.relation+' →'+(link.disputed?' (disputed)':'')),eventButton(byId.get(link.to),'ht-fishbone-evidence-event','Explore effect: '));
        if(link.explanation)row.append(make('p','',link.explanation));if(link.source)row.append(make('p','ht-detail-source',link.source));evidence.append(row);
      }
      card.append(evidence);
    }
    list.append(card);cards.push({id:diagram.outcome.id,card});
    if (options.chartZoom) {
      const zoom = mountChartZoom(scroll, canvas, { ...options.chartZoom,
        getSize: () => ({ width: geometry.width, height: geometry.height }) });
      card.insertBefore(zoom.controls, scroll);
      zoomControllers.push(zoom);
    }
  }
  select.addEventListener('change',()=>{for(const item of cards)item.card.hidden=Boolean(select.value)&&select.value!==item.id;});
  return () => { for (const zoom of zoomControllers) zoom.destroy(); };
}

module.exports={buildFishbones,buildTimelineFishbone,buildAnalysisFishbone,causalRanks,layoutFishbone,mountFishbones};
