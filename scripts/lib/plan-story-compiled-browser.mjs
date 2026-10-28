// The story screen reading a compiled made-up household, in the real app (check:plan-story-browser).
//
// A made-up couple is compiled by the real compiler and a story is built for it from `readPlanPosition`'s
// facts; the app opens the session. At the width it is given, this checks that
//   - links open the module of the compiled case the route uses, and ring the exact place where one exists;
//   - hover (or tap, on a phone) on a figure shows where it comes from, in the words code wrote for its kind;
//   - an info marker shows the explainer, with its sources and date;
//   - focus opens the same popover and Esc closes it, and nothing relies on colour alone;
//   - a popover stays on screen, and the page never scrolls sideways.
// A second made-up household, from the form, shows the question a stated figure answers.

import assert from 'node:assert/strict';
import { getExplainers } from '../../js/planning/figures/get_explainers.js';
import { describeBasis, formatBasisDate } from '../../js/plan_story_basis.js';
import { buildSessionFromPlan } from '../../js/plan_story_compiled.js';
import { PLAN_STORY_CASE_BRIDGES } from '../../js/plan_story_links.js';
import { compileMadeUpBorrower, compileMadeUpCouple, madeUpBorrowerStory, madeUpCoupleStory } from './plan-story-compiled.mjs';

const STORAGE_KEY = 'call_canvas_session_current';
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

let built = null;
function sessions() {
  built ??= (async () => {
    const quiet = async (work) => {
      const { info, warn, log } = console;
      console.info = console.warn = console.log = () => {};
      try { return await work(); } finally { Object.assign(console, { info, warn, log }); }
    };
    return quiet(async () => {
      const couple = await compileMadeUpCouple();
      const borrower = await compileMadeUpBorrower();
      return {
        couple: buildSessionFromPlan(couple, { current: madeUpCoupleStory('current'), clear_car: madeUpCoupleStory('clear_car') }),
        borrower: buildSessionFromPlan(borrower, { current: madeUpBorrowerStory() })
      };
    });
  })();
  return built;
}

/** What a popover for a basis must say: the label, every line, the questions, the sources, and what a mixed figure is made of. */
const wordsOf = (described) => [described.label, ...described.lines, ...(described.questions ?? []).map((q) => q.label ?? q.path),
  ...(described.sources ?? []).map((source) => source.title), ...described.evidence.flatMap(wordsOf)];
const expectedWords = (basis, moduleTitle = null) => wordsOf(describeBasis(basis, { moduleTitle })).filter(Boolean).map(squash);

async function openSession(page, origin, session) {
  // Leave the app before changing its storage: its unload handler saves the live session.
  await page.goto(`${origin}/dev/plan-story-demo.html`);
  await page.waitForSelector('body[data-ready]');
  await page.evaluate(([key, text]) => localStorage.setItem(key, text), [STORAGE_KEY, JSON.stringify(session)]);
  await page.goto(`${origin}/app/index.html`);
  await page.waitForSelector('.ps .ps-headline', { timeout: 20000 });
  // A page keeps the last pointer position (a touch screen keeps its last "hover"), so start with it off the story.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
}

const wrapOf = (locator) => locator.locator('xpath=ancestor::span[contains(@class,"ps-tw")][1]');
const popoverOf = (locator) => wrapOf(locator).locator(':scope > .ps-tip');

async function popoverText(locator) {
  return squash(await popoverOf(locator).innerText());
}

async function assertOnScreen(page, locator, label) {
  const box = await popoverOf(locator).boundingBox();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, `${label}: the popover stays on screen (${JSON.stringify(box)} in ${width})`);
}

export async function runCompiledBrowserChecks({ page, origin, size, output, note }) {
  const touch = size === 'phone';
  const { couple, borrower } = await sessions();
  const registry = (routeId, key) => couple.planStory.registries[routeId][key];
  await openSession(page, origin, couple);

  // The story reads the compiled plan: nine sections, goal subsections, and the plan's own routes.
  assert.equal(await page.locator('.ps-section').count(), 9, 'nine sections');
  assert.equal(await page.locator('.ps-route').count(), 4, 'the four compiled routes');
  assert.equal(await page.locator('#overviewGrid .overview-card').count(), couple.modules.length, 'a card for every compiled case');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'no sideways scroll');

  // 1. Every kind of basis is written from the fact. Hover on a computer, tap on a phone.
  const show = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    if (touch) await locator.tap(); else await locator.hover();
    await popoverOf(locator).waitFor({ state: 'visible' });
  };
  const away = async () => {
    // Away from every figure: a tap in the page's empty left margin, or the pointer off the page.
    if (touch) await page.touchscreen.tap(4, 420); else await page.mouse.move(0, 0);
    await page.waitForTimeout(80);
  };
  const kinds = {
    assumption: 'position.reserveMonths',
    stated: 'issues.idle_cash_vs_debt.home_loan.loanRate',
    calculated: 'position.reserve',
    official: 'figure.ie.dirt.2026.rate'
  };
  for (const [kind, key] of Object.entries(kinds)) {
    const figure = page.locator(`.ps-fig[data-ps-key="${key}"]`).first();
    assert.equal(await figure.getAttribute('data-ps-basis-kind'), kind, `${key} is a ${kind} figure`);
    await show(figure);
    const text = await popoverText(figure);
    for (const words of expectedWords(registry('current', key).basis)) assert.ok(text.includes(words), `${key}: the popover says “${words}” (got “${text}”)`);
    // Colour is never the only cue: the kind is a word with a mark, and the figure is underlined.
    assert.equal(await popoverOf(figure).locator('.ps-basis-kind svg').count(), 1, `${kind}: the kind has a mark`);
    const underline = await figure.evaluate((node) => getComputedStyle(node).textDecorationLine);
    assert.match(underline, /underline/, `${key}: a figure with a basis is underlined`);
    await assertOnScreen(page, figure, key);
    await away();
  }
  // A mixed calculation shows its parts, each with its own basis.
  const mixed = page.locator('.ps-fig[data-ps-key="issues.idle_cash_vs_debt.home_loan.cashRateAfterTax"]').first();
  await show(mixed);
  assert.equal(await popoverOf(mixed).locator('.ps-basis-ev').count(), 2, 'the cash rate after tax shows an assumption and an official figure');
  await away();
  note('a figure shows where it comes from, in words from its basis: assumption, stated, calculated, official, and a mixed calculation');

  // 2. A linked figure shows its basis as well as where it opens.
  const worth = page.locator('.ps-link[data-ps-key="current.position.netWorth"]').first();
  await show(worth);
  const worthText = await popoverText(worth);
  assert.ok(worthText.includes('Worked out by the app, in the Personal Balance Sheet module.'), `a linked figure names its module: ${worthText}`);
  assert.ok(worthText.includes('Opens the module with'), 'and still says what the link opens');
  await assertOnScreen(page, worth, 'netWorth link');
  if (touch) {
    assert.equal(await page.locator('body.focus-mode').count(), 0, 'the first tap on a linked figure shows its basis and opens nothing');
    assert.equal(await popoverOf(worth).locator('.ps-pop-open').isVisible(), true, 'a touch screen gets a button to open the module');
  }
  await away();

  // 3. Focus opens the same popover and Esc closes it.
  for (const selector of ['.ps-fig[data-ps-key="position.reserveMonths"]', '.ps-explain[data-ps-explainer="emergency_reserve"]', '.ps-link[data-ps-key="current.position.netWorth"]']) {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    await target.focus();
    await popoverOf(target).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await popoverOf(target).waitFor({ state: 'hidden' });
    assert.equal(await target.evaluate((node) => document.activeElement === node), true, 'Esc closes the popover and keeps focus where it was');
    await target.evaluate((node) => node.blur());
  }
  if (touch) {
    const figure = page.locator('.ps-fig[data-ps-key="position.reserveMonths"]').first();
    await show(figure);
    assert.equal(await figure.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    await popoverOf(figure).waitFor({ state: 'hidden' });
    await show(figure);
    await away();
    await popoverOf(figure).waitFor({ state: 'hidden' });
  }
  note('focus opens the same popover and Esc closes it');

  // 4. Explainers: the catalogue's own words, with sources and the day they were read.
  for (const id of ['emergency_reserve', 'dirt']) {
    const marker = page.locator(`.ps-explain[data-ps-explainer="${id}"]`).first();
    const [explainer] = getExplainers({ ids: [id] });
    assert.equal(await marker.evaluate((node) => node.tagName), 'BUTTON', 'the marker is a real button');
    assert.equal(await marker.getAttribute('aria-label'), `About: ${explainer.title}`);
    assert.ok(await marker.locator('svg').count(), 'the marker is a mark, not a colour');
    await show(marker);
    const text = await popoverText(marker);
    assert.ok(text.includes(explainer.title), `${id}: the title`);
    for (const sentence of explainer.sentences) assert.ok(text.includes(squash(sentence)), `${id}: every sentence, unchanged`);
    for (const source of explainer.sources) assert.ok(text.includes(source.title), `${id}: its sources`);
    assert.ok(text.includes(`Sources read on ${formatBasisDate(explainer.checkedOn)}.`), `${id}: the day its sources were read`);
    await assertOnScreen(page, marker, `explainer ${id}`);
    const box = await marker.boundingBox();
    assert.ok(box.width >= 16 && box.height >= 16, 'a visible marker');
    await away();
  }
  note('an info marker shows its explainer, with sources and date');

  // 5. Links open the module of the compiled case this route uses (the route's own cases differ from today's).
  await page.locator('.ps-route[data-ps-route="clear_car"]').first().click();
  await page.waitForFunction(() => document.querySelector('.ps')?.dataset.psRoute === 'clear_car');
  assert.equal(await page.locator('.ps-goal').count(), 4, 'a subsection for each goal');
  assert.equal(await page.locator('.ps-section').count(), 9);
  const links = await page.$$eval('.ps-link', (nodes) => nodes.map((node) => ({ key: node.dataset.psKey, chapter: node.dataset.psChapter, caseId: node.dataset.psCase, nativeCaseId: node.dataset.psNativeCase, focusTargetId: node.dataset.psFocusTarget })));
  assert.ok(links.length >= 4, `the clear_car story links its figures (${links.length})`);
  const caseIds = new Set(links.map((link) => link.caseId));
  assert.ok(caseIds.size >= 2, 'links reach more than one compiled case (this route’s and today’s)');
  const ringed = [];
  for (const link of links) {
    const target = page.locator(`.ps-link[data-ps-key="${link.key}"]`).first();
    await target.scrollIntoViewIfNeeded();
    if (touch) {
      await target.tap();
      await popoverOf(target).locator('.ps-pop-open').tap();
    } else await target.click();
    await page.waitForSelector('body.focus-mode', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.focused-module-card')?.dataset.moduleId);
    // The pill appears once the link has finished opening (a figure with no exact target is searched for first).
    await page.waitForSelector('.ps-pill-context', { timeout: 10000 });
    const opened = await page.evaluate(({ chapter, caseId, bridge }) => ({
      moduleId: document.querySelector('.focused-module-card').dataset.moduleId,
      caseNow: bridge ? window[`__get${bridge}ScenarioForModule`](caseId) : null,
      pill: document.querySelector('.ps-pill-context')?.innerText ?? ''
    }), { chapter: link.chapter, caseId: link.caseId, bridge: PLAN_STORY_CASE_BRIDGES[link.chapter] });
    assert.equal(opened.moduleId, link.caseId, `${link.key}: opens the module for the compiled case ${link.caseId.slice(0, 12)}`);
    if (opened.caseNow !== null) assert.equal(opened.caseNow, link.nativeCaseId, `${link.key}: on its native case`);
    assert.match(opened.pill, /Showing .* for /, `${link.key}: the pill says which route’s module is showing`);
    // The ring is drawn just before the pill appears. Where the live module marks the registered target, the ring is on it;
    // a target the live module does not mark (the balance sheet's summary row) opens the module on its case and rings nothing.
    if (await page.locator('.ps-outline').count()) {
      assert.equal(await page.locator('.ps-outline').getAttribute('data-ps-focus-target'), link.focusTargetId, `${link.key}: rings the exact registered target`);
      ringed.push(link.key);
    }
    await page.click('.ps-pill');
    await page.waitForFunction(() => !document.body.classList.contains('focus-mode'), null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.ps-here'), null, { timeout: 5000 });
    await page.waitForTimeout(500);
  }
  assert.ok(ringed.some((key) => key.startsWith('protection.')), `the protection figures ring their exact row (${ringed.join(', ')})`);
  note(`${links.length} links open the module for this route’s compiled case, ring the exact target where the module marks one, and come back to the same paragraph`);

  // 6. The at-a-glance figures carry their basis too.
  const glance = touch ? page.locator('.ps-card .ps-fig').first() : page.locator('.ps-glance-table .ps-fig').first();
  await show(glance);
  assert.ok((await popoverText(glance)).includes('Worked out by the app'), 'a glance figure says where it comes from');
  await assertOnScreen(page, glance, 'glance');
  await away();

  // 7. A route with no story says so; the story survives a reload.
  await page.evaluate(() => { document.querySelector('#overviewViewport').scrollTop = 0; });
  await page.locator('.ps-route[data-ps-route="fund_annually"]').first().click();
  await page.waitForSelector('.ps-status');
  assert.match(await page.locator('.ps-status').innerText(), /updating/i);
  await page.locator('.ps-route[data-ps-route="clear_car"]').first().click();
  await page.waitForSelector('.ps-link');
  await page.reload();
  await page.waitForSelector('.ps .ps-headline', { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'no sideways scroll after reload');
  await page.screenshot({ path: `${output}/${size}-compiled-story.png` });

  // 8. A figure stated on the form shows the form’s own question.
  await openSession(page, origin, borrower);
  const questionKey = 'issues.debts_other_than_mortgage.liability_application_loan_0.balance';
  const stated = page.locator(`.ps-fig[data-ps-key="${questionKey}"]`).first();
  assert.equal(await stated.getAttribute('data-ps-basis-kind'), 'stated');
  await show(stated);
  const statedText = await popoverText(stated);
  for (const words of expectedWords(borrower.planStory.registries.current[questionKey].basis)) assert.ok(statedText.includes(words), `a stated figure says “${words}” (got “${statedText}”)`);
  assert.ok(statedText.includes('Confirmed on 20 October 2026.'), 'and the day it was confirmed');
  await page.screenshot({ path: `${output}/${size}-stated-basis.png` });
  await away();
  note('a figure stated on the form shows its form question');
}
