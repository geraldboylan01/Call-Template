import { buildFocusedPane } from '../js/render.js';
import { newModulePreviews } from './new-module-preview-fixtures.js';
import { mortgageModule, balanceSheetModule } from './product-preview-fixtures.js';

const requested = new URLSearchParams(location.search).get('module');
const kind = ['mortgage','balance-sheet',...Object.keys(newModulePreviews)].includes(requested) ? requested : 'mortgage';
document.body.dataset.module = kind;
const module = newModulePreviews[kind] || (kind === 'mortgage' ? mortgageModule : balanceSheetModule);
const selectors = { mortgage: '.rcm-case', 'balance-sheet': '.pbs-scenario-option', 'future-cost-fund': '.fcf-case', 'household-cash-flow': '.hcf-case', 'protection-gap': '.pg-case' };
document.getElementById('demo-title').textContent = module.title;
document.getElementById('assumptions').textContent = kind === 'mortgage'
  ? 'Illustration · 4.25% interest held constant · same monthly repayment'
  : 'Illustration · property sale costs and taxes excluded';
let selectedId = kind === 'future-cost-fund' ? 'yearly' : newModulePreviews[kind] ? 'today' : 'current';
for (const name of ['FutureCostFund','HouseholdCashFlow','ProtectionGap']) {
  window['__get'+name+'ScenarioForModule'] = () => selectedId;
  window['__set'+name+'Scenario'] = (_moduleId,id) => { selectedId=id; };
}
window.__getMortgageScenarioForModule = () => selectedId;
window.__setMortgageScenario = (_moduleId, scenarioId) => { selectedId = scenarioId; };
window.__getPbsScenarioForModule = () => selectedId;
window.__setPbsScenario = (_moduleId, scenarioId) => { selectedId = scenarioId; };
const pane = buildFocusedPane({ module, moduleNumber: 1, moduleCount: 1, readOnly: true });
const nativeView = pane.querySelector(({mortgage:'.rcm','balance-sheet':'.pbs-scenario-shell','future-cost-fund':'.fcf','household-cash-flow':'.hcf','protection-gap':'.pg'})[kind]);
if (!nativeView) throw new Error('The native module did not render.');
document.getElementById('module').append(nativeView);
const notes = { 'future-cost-fund':'€15,000/year today · 4% education inflation · 0.134% net cash growth', 'household-cash-flow':'Illustration · 2026 tax estimate · loan payoff uses savings', 'protection-gap':'Illustrative payments · death case assumes mortgage cleared and lower costs' };
if (notes[kind]) document.getElementById('assumptions').textContent=notes[kind];
const cursor = document.getElementById('demo-cursor');
const ring = document.getElementById('demo-click');
window.previewCapture = {
  kind,
  cases() { return [...nativeView.querySelectorAll(selectors[kind])].map(button=>button.dataset.caseId || button.dataset.scenarioId); },
  setCaption(text) { document.getElementById('beat-label').textContent = text; },
  moveCursor(x, y, visible = true) {
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cursor.style.opacity = visible ? '1' : '0';
  },
  showClick(x, y, progress) {
    ring.style.left = `${x + 7}px`; ring.style.top = `${y + 8}px`;
    ring.style.transform = `translate(-50%, -50%) scale(${.4 + progress * 1.1})`;
    ring.style.opacity = progress < 1 ? String(.7 * (1 - progress)) : '0';
  },
  clickCase(index) {
    const buttons = nativeView.querySelectorAll(selectors[kind]);
    buttons[index].click();
  },
  buttonRect(index) {
    const button = nativeView.querySelectorAll(selectors[kind])[index];
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width * .56, y: rect.top + rect.height * .55 };
  },
  selected() { return selectedId; }
};
window.previewCapture.polishFrame = () => {
  if (kind !== 'balance-sheet') return;
  // These fictional positions are whole-euro amounts. Preserve that display
  // precision during the native count-up instead of flashing incidental cents.
  for (const node of nativeView.querySelectorAll('[data-pbs-value-format="currency"]')) {
    const amount = Number(node.textContent.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(amount)) node.textContent = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(amount);
  }
};
const openings = {
  'future-cost-fund': '€15,000 a year today: fees, accommodation and living costs.',
  'household-cash-flow': 'After the year’s bills and estimated tax: €9,200 left over.',
  'protection-gap': 'Two take-home incomes. €60,000 in savings. What if one stopped?'
};
window.previewCapture.setCaption(openings[kind] || (kind === 'mortgage' ? 'See what extra repayments change.' : 'See where your assets are held and what you owe.'));
await document.fonts.ready;
document.activeElement?.blur();
window.scrollTo(0, 0);
document.body.dataset.ready = 'true';
