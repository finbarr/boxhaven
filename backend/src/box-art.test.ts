import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxSVG, boxIdentity, boxState, creatorBadge } from './box-art.js';
test('portrait identity survives rename and state changes', () => {
 const machine = {name:'first',provider:'do',provider_id:'123',status:'online'};
 assert.equal(boxIdentity(machine),boxIdentity({...machine,name:'second'}));
 assert.equal(boxSVG(machine).match(/data-family="\d+"/)?.[0],boxSVG({...machine,name:'second',status:'offline'}).match(/data-family="\d+"/)?.[0]);
 assert.notEqual(boxSVG(machine),boxSVG({...machine,status:'offline'}));
});
test('lifecycle matches CLI heartbeat threshold and recovery precedence', () => {
 assert.equal(boxState({bootstrap_complete:true,agent_last_seen_at:new Date(Date.now()-240000).toISOString()}),'online');
 assert.equal(boxState({bootstrap_complete:true,agent_last_seen_at:new Date(Date.now()-360000).toISOString()}),'offline');
 assert.equal(boxState({status:'online',create_state:'recovery_required'}),'recovery');
 assert.match(boxSVG({create_state:'recovery_required'}),/#d3554b/);
 assert.match(boxSVG({create_state:'provisioning'}),/#e9a43c/);
});
test('untrusted labels never enter SVG and unknown creators are not invented', () => {
 assert.doesNotMatch(boxSVG({name:'<script>alert(1)</script>'}),/script|alert/);
 assert.equal(creatorBadge({user_id:'internal-uuid'}),null);
 assert.equal(creatorBadge({owner_name:'Jamie Taylor'})?.initials,'JT');
});
