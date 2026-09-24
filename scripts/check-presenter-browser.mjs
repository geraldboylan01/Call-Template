#!/usr/bin/env node
// Uses installed Playwright + Chrome against the actual app. Pass a package
// directory to validate a real case; no financial renderer is substituted.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadPresentationSession, preparePreview } from './presenter-package.mjs';
import { buildPresentationCatalogue, fingerprint } from '../js/presenter_catalogue.js';
if (process.argv.includes('--recording-only')) { const {checkPresenterRecording}=await import('./presenter-recording-browser.mjs'); await checkPresenterRecording(); process.exit(0); }
if (process.argv.includes('--capture-only')) { const {checkNativeCapture}=await import('./presenter-capture-browser.mjs'); await checkNativeCapture(); process.exit(0); }
if (process.argv[2] === '--design-only') { const {checkPresenterDesign}=await import('./presenter-design-browser.mjs'); await checkPresenterDesign(process.argv[3]); process.exit(0); }
const supplied = process.argv[2], dir = supplied || 'private/aam-makeovers/presenter-regression';
if (!supplied) {
  console.info = () => {};
  const raw = JSON.parse(await fs.readFile('scripts/fixtures/case-packs/valid-call.json'));
  const session = loadPresentationSession(raw);
  session.modules.push({id:'test-report',title:'Regression report',generated:{report:{version:1,title:'Regression report',blocks:[
    {id:'totals',type:'kpiRow',title:'Resources',items:[{id:'reserve',label:'Reserve',value:'€15,000'}]},
    {id:'timeline',type:'timeline',title:'Journey',svgSpec:{kind:'timeline',events:[{id:'build',dateLabel:'Age 54–57',title:'Build',body:'An age range must retain its authored order.'},{id:'start',dateLabel:'Age 60',title:'Start',body:'A real timeline event.'},{id:'end',dateLabel:'Age 65',title:'Pensions',body:'Income begins.'}]}},
    {id:'chart',type:'chart',title:'Portfolio',chart:{type:'line',labels:['60','65'],datasets:[{label:'Balance',data:[15000,12000]}],display:{valueFormat:'currency'}}},
    {id:'detail',type:'accordion',title:'Assumptions',items:[{id:'first',title:'First',markdown:'Default note.'},{id:'second',title:'Second',markdown:'This disclosure must open.'}]}
  ]}}});session.order.push('test-report');
  const normalized=loadPresentationSession(session), cat=buildPresentationCatalogue(normalized);
  const choose=(fn)=>{const t=cat.targets.find(fn);assert.ok(t);return t.id;};
  const module=(kind)=>choose(t=>t.kind==='module'&&cat.modules.find(m=>m.key===t.moduleKey)?.kind===kind);
  const steps=[
    {id:'balance',label:'BALANCE',operations:[{action:'frame',target:module('balance-sheet')}]},
    {id:'state-focus',label:'CLEAR LOAN',operations:[{action:'state',target:module('balance-sheet'),scenarioId:'clear-the-loan'},{action:'focus',target:choose(t=>t.scenarioId==='clear-the-loan'&&t.kind==='holding'&&t.label==='Savings')}]},
    {id:'pension',label:'PENSION',operations:[{action:'state',target:module('pension'),scenarioId:'retire-60'}]},
    {id:'mortgage',label:'MORTGAGE',operations:[{action:'frame',target:module('mortgage')}]},
    {id:'event',label:'EVENT',operations:[{action:'focus',target:choose(t=>t.ref.type==='timeline-event'&&t.ref.eventId==='end')}]},
    {id:'point',label:'POINT',operations:[{action:'focus',target:choose(t=>t.ref.type==='chart-point'&&t.xLabel==='65')}]},
    {id:'detail',label:'DETAIL',operations:[{action:'focus',target:choose(t=>t.ref.type==='report-item'&&t.ref.itemId==='second')}]},
    {id:'reset',label:'RESET',operations:[{action:'reset',target:choose(t=>t.moduleLabel==='Regression report'&&t.kind==='module')}]}
  ];
  // Use the actual fixture scenario ID, so the fixture can evolve without a
  // copied list of calculator cases in this browser test.
  steps[2].operations[0].scenarioId=cat.modules.find(m=>m.kind==='pension').scenarios.at(-1).id;
  const script=steps.map(s=>`Explain ${s.id}.`).join('\n\n');
  const pkg={version:1,id:'regression',title:'Regression',caseFingerprint:cat.caseFingerprint,scriptHash:fingerprint(script),steps,cues:steps.map(s=>({stepId:s.id,before:`Explain ${s.id}.`})),narrativeReview:{status:'passed',claims:[{quote:'Explain balance.',targetIds:[steps[0].operations[0].target],assessment:'Synthetic test, not financial advice.',status:'supported'}],scenarioIndependence:'No cross-module updates.',assumptionsAndCaveats:'Synthetic fixture.'}};
  await preparePreview(normalized,dir);await fs.writeFile(path.join(dir,'presentation.json'),JSON.stringify(pkg,null,2));await fs.writeFile(path.join(dir,'script.md'),script);
}
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:process.argv.includes('--motion')?'no-preference':'reduce'});
 await page.bringToFront();
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 console.log('Opening live app');
 await page.goto(`${process.env.PRESENTER_BASE_URL || 'http://127.0.0.1:8788'}/${dir}/`);
 await page.waitForFunction(()=>window.planeirPresenter?.state().active&&!window.planeirPresenter.state().busy,{timeout:15000});
 console.log('App ready');
 const before=await page.evaluate(()=>({source:JSON.stringify(window.planeirPresenter.discover()),storage:JSON.stringify({...localStorage}),count:window.planeirPresenter.state().count}));
 assert.equal(await page.evaluate(()=>window.planeirPresenter.state().index),-1);
 await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!window.planeirPresenter.state().busy);assert.equal(await page.evaluate(()=>window.planeirPresenter.state().index),0);
 await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>!window.planeirPresenter.state().busy);assert.equal(await page.evaluate(()=>window.planeirPresenter.state().index),-1);
 console.log('Validating all beats');
 const validation=await page.evaluate(()=>window.planeirPresenter.validateLive());
 await fs.writeFile(path.join(dir,'validation-live-1920.json'),JSON.stringify(validation,null,2));
 assert.deepEqual(validation.failures,[]);assert.equal(validation.evidence.length,before.count*2-1);
 await page.evaluate(()=>window.planeirPresenter.goTo(1));
 if (!supplied) { await page.evaluate(()=>window.planeirPresenter.goTo(4)); assert.deepEqual(await page.locator('[data-timeline-event-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.timelineEventId)),['build','start','end']); await page.evaluate(()=>window.planeirPresenter.goTo(1)); }
 const state=await page.evaluate(()=>window.planeirPresenter.state());assert.equal(state.index,1);
 await page.screenshot({path:path.join(dir,'preview-1920.png')});
 await page.evaluate(()=>window.planeirPresenter.goTo(0));await page.evaluate(()=>window.planeirPresenter.next());
 assert.deepEqual(await page.evaluate(()=>window.planeirPresenter.state().scenarios),state.scenarios);
 await page.keyboard.press('h');await page.waitForFunction(()=>document.body.classList.contains('presenter-hud-hidden') && getComputedStyle(document.querySelector('.presenter-hud')).visibility === 'hidden');assert.equal(await page.locator('.presenter-hud').evaluate(el=>getComputedStyle(el).visibility),'hidden');
 assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('presenter-hud-hidden')),true);await page.keyboard.press('h');
 const during=await page.evaluate(()=>({source:JSON.stringify(window.planeirPresenter.discover()),storage:JSON.stringify({...localStorage})}));assert.equal(during.source,before.source);assert.equal(during.storage,before.storage);
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!window.planeirPresenter.state().active);
 assert.equal(await page.evaluate(()=>JSON.stringify(window.planeirPresenter.discover())),before.source);
 assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),before.storage);
 await page.locator('.presenter-setup').evaluate(el=>el.close());
 await page.evaluate(()=>window.planeirPresenter.start());
 await page.setViewportSize({width:1280,height:720});
 const small=await page.evaluate(()=>window.planeirPresenter.validateLive());await fs.writeFile(path.join(dir,'validation-live-1280.json'),JSON.stringify(small,null,2));assert.deepEqual(small.failures,[]);
 await page.evaluate(()=>window.planeirPresenter.goTo(Math.min(5,window.planeirPresenter.state().count-1)));await page.screenshot({path:path.join(dir,'preview-1280.png')});
 if (process.argv.includes('--screenshots')) {
  await fs.mkdir(path.join(dir,'preview-beats'),{recursive:true});
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(()=>window.planeirPresenter.restart());
  for(let i=0;i<before.count;i++) {
   await page.keyboard.press('ArrowRight'); await page.waitForFunction(()=>!window.planeirPresenter.state().busy);
   const state=await page.evaluate(()=>window.planeirPresenter.state()); assert.equal(state.index,i);assert.equal(state.error,'');
   await page.screenshot({path:path.join(dir,'preview-beats',`${String(i+1).padStart(2,'0')}.png`)});
  }
 }
 if (!supplied) {
  console.log('Checking camera reserve and writable-session isolation');
  await page.locator('.presenter-camera').evaluate(el=>el.hidden=false);
  await page.waitForFunction(()=>document.querySelector('#swipeStage').getBoundingClientRect().right < document.querySelector('.presenter-camera').getBoundingClientRect().left, null, {timeout:5000});
  const layout=await page.evaluate(()=>({stage:document.querySelector('#swipeStage').getBoundingClientRect().right,camera:document.querySelector('.presenter-camera').getBoundingClientRect().left}));
  assert.ok(layout.stage < layout.camera, `Camera reserve must not overlap the live app: ${JSON.stringify(layout)}`);
  await page.locator('.presenter-camera').evaluate(el=>el.hidden=true);
  // Enable ordinary app saving and leave a save pending as Presenter starts.
  // Mock only the auth endpoint; no request reaches a production service.
  const ordinaryHtml=(await fs.readFile(path.join(dir,'index.html'),'utf8')).replace('./preview.js','./persistence.js');
  await fs.writeFile(path.join(dir,'persistence.html'),ordinaryHtml);
  const ordinaryBoot=(await fs.readFile(path.join(dir,'preview.js'),'utf8')).replace('readOnly: true, persistLocalSession: false','readOnly: false, persistLocalSession: true, allowPublish: false').replace('await window.planeirPresenter.start();','window.persistenceReady = true;');
  await fs.writeFile(path.join(dir,'persistence.js'),ordinaryBoot);
  const normal=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'reduce'});
  await normal.bringToFront();
  await normal.route('https://api.planeir.ie/**',route=>route.request().url().endsWith('/api/auth/session')?route.fulfill({json:{authEnabled:false,authenticated:false}}):route.abort());
  await normal.goto(`${process.env.PRESENTER_BASE_URL || 'http://127.0.0.1:8788'}/${dir}/persistence.html`);
  await normal.waitForFunction(()=>window.persistenceReady);
  console.log('Writable session ready');
  await normal.fill('#clientNameInput','Pending save isolation test');
  await normal.evaluate(()=>{document.activeElement.blur();return window.planeirPresenter.start();});
  await normal.evaluate(()=>window.planeirPresenter.goTo(1));
  await normal.waitForTimeout(600);
  const saved=await normal.evaluate(()=>JSON.parse(localStorage.getItem('call_canvas_session_current')));
  assert.equal(saved.clientName,'Pending save isolation test');
  const balance=saved.modules.find(m=>m.generated.outputsBucketed);
  assert.ok(!balance.ui.pbsScenarioId || balance.ui.pbsScenarioId==='current');
  const savedText=await normal.evaluate(()=>localStorage.getItem('call_canvas_session_current'));
  await normal.evaluate(()=>window.planeirPresenter.exit());
  await normal.locator('.presenter-setup').evaluate(el=>el.close());
  assert.equal(await normal.evaluate(()=>localStorage.getItem('call_canvas_session_current')),savedText);
  assert.equal(await normal.evaluate(id=>window.__getPbsScenarioForModule(id),balance.id),'current');
  // Ordinary scenario controls and autosave must resume after leaving Presenter.
  await normal.locator('#swipeStage button').filter({hasText:'Clear the credit union loan'}).click();
  await normal.waitForTimeout(600);
  const after=await normal.evaluate(()=>JSON.parse(localStorage.getItem('call_canvas_session_current')));
  assert.equal(after.modules.find(m=>m.id===balance.id).ui.pbsScenarioId,'clear-the-loan');
  console.log('Writable-session isolation: pending autosave preserved original state; normal scenario saving resumed on exit.');
  await normal.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'passed',steps:before.count,viewports:['1920x1080','1280x720'],checks:['all forward/backward targets','arrow keys','ready boundary','H','Escape','scenario reconstruction','original source unchanged','local storage unchanged','no page errors'],dir}));
} finally { await browser.close(); }
