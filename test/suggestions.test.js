'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {suggestionRank,matchingSuggestions}=require('../src/suggestions');
test('suggestions accept word starts and phrases but reject interior Latin letters',()=>{
 assert.equal(suggestionRank('Russia','u'),-1);
 assert.ok(suggestionRank('U.S.','u')>=0);
 assert.ok(suggestionRank('The Anglo-German Naval Agreement','naval')>=0);
 assert.ok(suggestionRank('The Anglo-German Naval Agreement','anglo german')>=0);
 assert.equal(suggestionRank('The Anglo-German Naval Agreement','aval'),-1);
 assert.ok(suggestionRank('the Mukden Incident 九一八事变','事变')>=0);
 assert.ok(suggestionRank('World History','history')>=0);
});
test('event typo matches need four letters and rank after exact and word-prefix matches',()=>{
 const names=['The Stresa Front','Sresa negotiations','The Sresa Agreement','Sresa'];
 assert.deepEqual(matchingSuggestions(names,'sresa',undefined,{fuzzy:true}),['Sresa','Sresa negotiations','The Sresa Agreement','The Stresa Front']);
 assert.ok(suggestionRank('The Stresa Front','sresa',{fuzzy:true})>=0);
 assert.ok(suggestionRank('The Stresa Front','stersa',{fuzzy:true})>=0);
 assert.equal(suggestionRank('Russia','u',{fuzzy:true}),-1);
 assert.equal(suggestionRank('Russia','rusxxy',{fuzzy:true}),-1);
 assert.equal(suggestionRank('The Stresa Front','sresa'),-1);
 assert.equal(suggestionRank('The Stresa Front','stresa',{ignoreCase:false,fuzzy:true}),-1);
 assert.ok(suggestionRank('The Stresa Front','Stresa',{ignoreCase:false})>=0);
});

test('search ignores standalone articles in either name or query without losing prefix or case rules',()=>{
 for(const [name,query] of [
  ['Treaty of Portsmouth','the Treaty of Portsmouth'],
  ['The Treaty of Portsmouth','Treaty of Portsmouth'],
  ['The end of the war','end of war'],
  ['End of war','the end of the war'],
  ['An agreement with a country','agreement with country']
 ]) assert.ok(suggestionRank(name,query)>=0,`${query} should match ${name}`);
 assert.equal(suggestionRank('Russia','a'),-1);
 assert.equal(suggestionRank('Russia','u'),-1);
 assert.equal(suggestionRank('Thermopylae','rmopylae'),-1);
 assert.ok(suggestionRank('Anschluss','an')>=0);
 assert.equal(suggestionRank('Treaty','the treaty',{ignoreCase:false}),-1);
 assert.ok(suggestionRank('Treaty','the Treaty',{ignoreCase:false})>=0);
 const events=[{title:'Incident',aliases:['The end of the war']}];
 assert.deepEqual(matchingSuggestions(events,'end of war',e=>[e.title,...e.aliases]),events);
 const {searchText}=require('../src/suggestions');
 assert.equal(searchText('the U.S. and an A-bomb'),'U.S. and A-bomb');
 assert.equal(searchText('the U.S.A.'),'U.S.A.');
 assert.equal(searchText('The (an agreement) with a country'),'( agreement) with country');
 assert.equal(searchText('the an a treaty'),'treaty');
 assert.equal(searchText("The A-bomb, O’The and theatre"),"A-bomb, O’The and theatre");
 assert.equal(searchText('a'),'a');assert.equal(searchText('an'),'an');
 assert.equal(searchText('The Hague'),'Hague');
});
