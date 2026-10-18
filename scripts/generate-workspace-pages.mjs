import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_COPY as copy, WORKSPACE_FAQS } from '../js/workspace/copy.js';

import { DEMO_POLICY as WORKSPACE_POLICY } from '../js/workspace/demo_contract.js';
import { EDUCATION_CALL } from '../js/workspace/education_call.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const scriptJson = (value) => JSON.stringify(value, null, 2).replaceAll('<', '\\u003c');
function head(title, description, up, canonical, extra = '') {
  return `<!doctype html>
<html lang="en-IE">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="description" content="${escape(description)}" />
  <link rel="canonical" href="https://planeir.ie${canonical}" />
  <meta property="og:site_name" content="Planeir" />
  <meta property="og:title" content="${escape(title)}" />
  <meta property="og:description" content="${escape(description)}" />
  <meta property="og:url" content="https://planeir.ie${canonical}" />
  <meta property="og:image" content="https://planeir.ie/assets/brand/planeir-social-card-newgrange.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escape(title)}" />
  <meta name="twitter:description" content="${escape(description)}" />
  <meta name="twitter:image" content="https://planeir.ie/assets/brand/planeir-social-card-newgrange.png" />
  <title>${escape(title)}</title>
  <link rel="icon" type="image/svg+xml" href="${up}favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="${up}favicon-32.png" />
  <link rel="shortcut icon" href="${up}favicon.ico" />
  <link rel="apple-touch-icon" sizes="180x180" href="${up}apple-touch-icon.png" />
  <link rel="stylesheet" href="${up}styles/landing.css" />
  <link rel="stylesheet" href="${up}styles/cases.css" />
  <link rel="stylesheet" href="${up}styles/product-preview.css" />
  <link rel="stylesheet" href="${up}styles/workspace.css" />
${extra ? `  ${extra}\n` : ""}</head>
<body><div class="landing-shell">
  <div class="landing-ambient landing-ambient-one" aria-hidden="true"></div>
  <div class="landing-grid" aria-hidden="true"></div>`;
}
function header(up, admin = false) {
  return `<header class="site-header">
    <a class="site-brand" href="${up}" aria-label="Planeir home"><span class="site-brand-logo-wrap"><img class="site-brand-logo" src="${up}assets/brand/planeir-lockup-light.svg" alt="Planeir" width="1330" height="384" /></span></a>
    <nav class="site-header-actions" aria-label="Site">${admin ? `<a class="site-nav-admin-login" href="${up}app/?login=1&return=home" data-advisor-login-link>Admin login</a><a class="site-nav-app advisor-app-link is-hidden" href="${up}app/" data-advisor-app-link hidden>Open app</a>` : ''}<a class="button button-primary button-sm" href="${up}apply/">${copy.create}</a></nav>
  </header>`;
}
function footer(up) {
  return `<footer class="site-footer"><p class="site-footer-note">Planeir provides financial education, not regulated advice. <a href="${up}privacy/">Privacy</a> · <a href="${up}terms/">Terms</a> · <a href="mailto:hello@planeir.ie">hello@planeir.ie</a></p></footer></div></body></html>`;
}
const faq = WORKSPACE_FAQS.map(([question, answer]) => `<details class="faq-item"><summary>${escape(question)}</summary><p>${escape(answer)}</p></details>`).join('\n');
const structured = { '@context': 'https://schema.org', '@graph': [
  { '@type': 'WebSite', name: 'Planeir', alternateName: 'Planeir', url: 'https://planeir.ie/', inLanguage: 'en-IE', description: copy.description },
  { '@type': 'Person', name: 'Gerry Boylan', hasCredential: { '@type': 'EducationalOccupationalCredential', credentialCategory: 'Qualified Financial Adviser (QFA)', recognizedBy: { '@type': 'Organization', name: 'IOB' } } },
  { '@type': 'FAQPage', mainEntity: WORKSPACE_FAQS.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })) }
] };
const home = `${head('Planeir | Private financial education', copy.description, './', '/', `<script type="application/ld+json">${scriptJson(structured)}</script>`)}
${header('./', true)}
<main>
  <section class="hero-section">
    <div class="hero-copy">
      <p class="section-eyebrow">Currently available for demos only · Built for Ireland</p>
      <h1 class="hero-title">${copy.headline}</h1>
      <p class="hero-subtitle">${copy.introduction}</p>
      <div class="hero-actions"><a class="button button-primary" href="./apply/">${copy.create}</a><a class="button button-secondary" href="#how-it-works">How it works</a></div>
    </div>
          <figure id="module-examples" class="workspace-example product-preview" data-product-preview>
            <div class="preview-tabs" role="tablist" aria-label="Example modules">
                <button id="previewMortgageTab" type="button" role="tab" aria-selected="true" aria-controls="previewPanel" data-preview-module="mortgage">Mortgage</button>
                <button id="previewBalanceTab" type="button" role="tab" aria-selected="false" aria-controls="previewPanel" tabindex="-1" data-preview-module="balance-sheet">Personal balance sheet</button>
                <button id="previewCollegeTab" type="button" role="tab" aria-selected="false" aria-controls="previewPanel" tabindex="-1" data-preview-module="future-cost-fund">College funding</button>
                <button id="previewCashFlowTab" type="button" role="tab" aria-selected="false" aria-controls="previewPanel" tabindex="-1" data-preview-module="household-cash-flow">Household cash flow</button>
                <button id="previewProtectionTab" type="button" role="tab" aria-selected="false" aria-controls="previewPanel" tabindex="-1" data-preview-module="protection-gap">Protection gap</button>
            </div>
            <div id="previewPanel" class="preview-stage" role="tabpanel" aria-labelledby="previewMortgageTab"><video data-preview-video muted playsinline preload="none" poster="./assets/examples/mortgage-preview-desktop-poster.png" width="1440" height="1080" aria-label="Mortgage scenario comparison using fictional figures"><source type="video/mp4" /><source type="video/webm" /></video></div>
            <div class="preview-controls"><span>Actual modules · Fictional figures</span><div><button type="button" data-preview-play>Play preview</button>
                <button type="button" data-preview-enlarge>Enlarge</button></div></div>
            <figcaption data-preview-caption aria-live="polite">Compare how extra repayments change the finish date and interest cost.</figcaption>
            <dialog class="preview-dialog" aria-labelledby="previewDialogTitle"><div class="preview-dialog-header"><h2 id="previewDialogTitle">Planeir example · Fictional figures</h2><button type="button" data-preview-close>Close</button></div><video controls muted playsinline preload="none" aria-label="Enlarged module example"><source type="video/mp4" /><source type="video/webm" /></video><p data-preview-context></p><div class="preview-dialog-footer"><a class="button button-primary" href="./apply/">${copy.create}</a></div></dialog>
          </figure>
  </section>
  <section class="trust-row-section" aria-label="About Planeir"><div class="trust-row"><span>Designed by Gerry Boylan, QFA</span><span class="trust-row-divider" aria-hidden="true"></span><span>Built for Ireland</span><span class="trust-row-divider" aria-hidden="true"></span><span>Financial education</span></div></section>
  <section id="how-it-works" class="content-section how-section" aria-labelledby="howTitle"><div class="section-heading"><p class="section-eyebrow">How Planeir works</p><h2 id="howTitle">From your figures to a clearer picture.</h2></div><div class="how-grid">
    <article class="how-card"><h3>1. Share your goals and figures</h3><p>Tell Planeir what you want to understand. Fill in what you can. Estimates are fine. Skip anything you don’t know.</p></article>
    <article class="how-card"><h3>2. Request demo access</h3><p>Your information is saved. We’ll email you when access is available, and you can update your figures while you wait.</p></article>
    <article class="how-card"><h3>3. Review and confirm</h3><p>Open your private link and review your saved information. Analysis generation will be connected separately; confirming your figures does not start an analysis yet.</p></article>
  </div></section>
  <section class="content-section how-section" aria-labelledby="founderTitle"><div class="section-heading"><p class="section-eyebrow">Why I built Planeir</p><h2 id="founderTitle">Financial understanding should not be a privilege.</h2></div><p class="workspace-founder">${copy.founder}</p><p class="workspace-founder">${copy.founderContext}</p></section>

  <section class="content-section faq-section" aria-labelledby="faqTitle"><div class="section-heading"><p class="section-eyebrow">Questions</p><h2 id="faqTitle">What to expect.</h2></div><div class="faq-list">${faq}</div></section>
  <section id="request-demo" class="content-section"><div id="advisorGateNotice" class="advisor-gate-notice is-hidden" tabindex="-1" hidden><h2>The admin workspace is private.</h2><p>To try Planeir, request demo access. Existing participants should use their private return link.</p></div><div class="how-card"><h2>Request access to the Planeir demo.</h2><p>Share your goals and figures so your information is ready when you are invited.</p><a class="button button-primary" href="./apply/">${copy.create}</a></div></section>
</main>
<script>window.__WORKER_BASE_URL = "https://api.planeir.ie";</script><script type="module" src="./js/landing.js"></script><script type="module" src="./js/workspace/previews.js"></script>
${footer('./')}`;

// The body is shared by both public notice URLs. Archived notices apply only
// to the old case-video service and the separately invited consumer beta.
const privacyBody = `<p class="section-eyebrow">Privacy notice · ${WORKSPACE_POLICY.privacyNoticeId}</p><h1 class="page-title">How we handle your information</h1>
<p class="page-lede">Planeir is operated by Gerry Boylan in Ireland. Contact <a href="mailto:hello@planeir.ie">hello@planeir.ie</a>.</p>
<div class="workspace-notice"><h2>Demo requests and saved information</h2><p>Currently available for demos only. Requesting access sends your information to Planeir for storage and demo access management. Analysis generation is not connected yet; this form sends no information to an AI provider. Unfinished edits are saved in your browser until you submit them.</p></div>
<div class="page-content">
<section class="page-card"><h2>What the workspace collects</h2><p>Your name and email for private return access, the goals, household details and figures you enter, your demo access status, confirmed information, and records of the terms and notices you acknowledge. Estimates and unknown figures are identified.</p><p>Do not enter PPS numbers, passwords, PINs, full account or card numbers, an exact address, identity documents or unnecessary information about someone else.</p></section>
<section class="page-card"><h2>Why we use it</h2><p>We use your information to save your demo request, manage approval or an invitation, provide private return access, and handle corrections, confirmation or deletion. The lawful basis for this service is performance of our agreement with you under the Terms of Use.</p><p>Limited security and operational records support our legitimate interests in preventing misuse, controlling service costs and maintaining reliability. Optional calls are a separate service you request. The workspace does not publish your answers, sell your financial information or send it to an adviser.</p></section>
<section class="page-card"><h2>Analysis and AI</h2><p>Analysis generation is not connected to this demo flow. Requesting access, editing your information and choosing Generate my analysis save information and confirmation only. They do not start calculations or send your information to an AI provider. Any future analysis processing will be explained before it is enabled.</p></section>
<section class="page-card"><h2>Who processes the information</h2><ul><li>Cloudflare runs the API and database. Demo contact details, goals, figures and confirmations are encrypted in storage.</li><li>Resend delivers demo receipts, private return links and access emails. Financial figures are not included in these emails.</li><li>GitHub hosts the website pages.</li><li>Zoom hosts separately requested private education calls; it is not used to submit demo information.</li></ul><p>Authorised support, including Gerry, may access information when needed to operate the service, investigate a problem or respond to your request. A private workspace does not mean that no service provider or authorised support can access it.</p><p>Providers may process information outside the European Economic Area. Providers operate under their service and data-processing terms, including applicable international transfer safeguards. Contact us for information about these arrangements. Demo submissions do not use AI processing.</p></section>
<section class="page-card"><h2>Saved access and deletion</h2><p>Your saved demo information remains until you delete it. Use <strong>Delete my saved information</strong> in your private form to remove your contact details, figures, confirmation, access links, sessions and associated email queue records from the active service. Use <strong>Clear this device</strong> to remove the browser draft and end this browser’s private session without deleting your saved request. Provider backups follow their own recovery lifecycle.</p><p>Private email links expire after 24 hours; browser sessions expire after seven days. Expired access records are cleaned up by scheduled maintenance. Email delivery metadata is kept for up to 30 days, with encrypted email bodies removed after sending or final failure. Rate-limit counters expire logically after one hour and are removed by routine cleanup. Email providers keep their own delivery records under their terms. Separate booking records are governed by the service you requested.</p></section>
<section class="page-card" id="optional-call"><h2>Personalised Planéir Walkthrough</h2><p>After viewing your completed analysis, you can purchase a ${EDUCATION_CALL.priceLabel}, ${EDUCATION_CALL.durationMinutes}-minute Zoom walkthrough with Gerry Boylan, the creator of Planéir. With your explicit permission, an encrypted copy of that exact report and your saved contact details are shared so Gerry can prepare and explain it. This is separate from permission for any adviser introduction; your information is not distributed to other advisers.</p><p>Cloudflare stores the purchase, booking and encrypted report copy. Stripe hosts checkout and processes payment; Resend delivers payment and booking emails; Zoom hosts the private call. Planéir does not collect your card details. We retain payment references, amounts and payment/refund status. Optional discussion topics are stored encrypted and included in Gerry’s private booking email. Please avoid account numbers, passwords or other unnecessary sensitive details. Calls are unrecorded by default.</p><p>Payment is verified before you choose a time, and your paid purchase stays saved if you leave before scheduling. Appointments require at least 24 hours’ notice. You may decline a proposed replacement without changing the original time. The shared report copy is retained while a paid walkthrough awaits scheduling, then expires 30 days after the call or cancellation; unpaid attempts expire after 30 days. Scheduled maintenance removes expired copies from active storage. Accounting and refund records are retained for the applicable statutory period, normally six years. Earlier Revolut Pro bookings retain their agreed terms. Email hello@planeir.ie for access, correction, cancellation or deletion requests.</p></section>
<section class="page-card"><h2>Your rights</h2><p>You may request access, correction, deletion, restriction or portability, or object to processing based on legitimate interests, where applicable. Where processing relies on consent, you may withdraw it without affecting earlier lawful processing. Email <a href="mailto:hello@planeir.ie">hello@planeir.ie</a>. You may complain to the <a href="https://www.dataprotection.ie/">Irish Data Protection Commission</a>.</p></section>
<section class="page-card" id="previous-services"><h2>Existing applications and invited sessions</h2><p>Earlier case-video applications remain covered by the <a href="/privacy/legacy-applications.html">original application notice</a>. The separately invited consumer beta remains covered by its <a href="/plan/privacy-legacy.html">original consumer notice</a>, including its seven-day session expiry and optional voice processing. Those permissions are not permission to create a new workspace.</p></section>
</div>`;
function privacy(up) {
  return `${head('Privacy notice | Planeir', 'How Planeir handles saved demo requests, private access and earlier services.', up, '/privacy/')}${header(up)}<main class="page-main"><section class="page-intro">${privacyBody}</section></main>${footer(up)}`;
}
const terms = `${head('Terms of Use | Planeir', 'Terms for your private financial education workspace.', '../', '/terms/')}${header('../')}<main class="page-main"><section class="page-intro"><p class="section-eyebrow">Terms of Use · ${WORKSPACE_POLICY.termsId}</p><h1 class="page-title">Using Planeir</h1><p class="page-lede">These terms cover demo requests, private return access and confirming your information. Planeir is currently available for demos only; analysis generation is not connected to this flow.</p></section><div class="page-content">
<section class="page-card"><h2>Who provides the service</h2><p>Planeir is built and run by Gerry Boylan, a sole trader based in Dublin, Ireland. Contact <a href="mailto:hello@planeir.ie">hello@planeir.ie</a>. These terms describe the private workspace; they do not replace the terms of an earlier invited session.</p></section>
<section class="page-card"><h2>Financial education</h2><p>${copy.educationNotice}</p><p>The service is for adults aged 18 or over using their own household information. Share another person’s information only where you are entitled to do so and it is needed.</p></section>
<section class="page-card"><h2>Information and assumptions</h2><p>You can enter estimates and leave unknown figures blank. Review and correct your saved information before confirming it. Generate my analysis currently saves that confirmation only; it does not create an analysis. Any later modelled outcomes depend on the information and assumptions used and are not guarantees.</p></section>
<section class="page-card"><h2>Your saved demo information</h2><p>Your information remains until you delete it. Requesting access does not guarantee an invitation or a launch date. You can update or delete your saved information using your private return link. The <a href="../privacy/">privacy notice</a> explains processing, access and deletion.</p></section>
<section class="page-card" id="walkthrough"><h2>Personalised Planéir Walkthrough · ${EDUCATION_CALL.version}</h2><p>A walkthrough with Gerry Boylan, the creator of Planéir, costs ${EDUCATION_CALL.priceLabel} in total for ${EDUCATION_CALL.durationMinutes} minutes on Zoom. Your completed analysis remains free. Gerry explains your projections, assumptions and scenarios and helps you use the tools. The session is educational and does not include regulated advice, product recommendations, written recommendations or ongoing support. Calls are private and unrecorded by default.</p><p>Pay securely through Stripe, then choose a time at least 24 hours ahead. Eligible payment methods, including Apple Pay, Google Pay and cards, are displayed by Stripe where available. Your paid purchase remains saved if you leave before scheduling. Choose a time within 19:30–21:00 on weekdays or 12:00–17:00 on weekends, in Europe/Dublin time. Starts are offered every 15 minutes and the whole call fits within those hours. The app prevents overlapping appointments and sends the Zoom invitation after your time is booked. Gerry may propose a replacement, which takes effect only when you accept it; the original time is retained meanwhile. Rescheduled calls also require at least 24 hours’ notice.</p><p>You can cancel before the call starts for a full refund by emailing <a href="mailto:hello@planeir.ie">hello@planeir.ie</a>. Refunds are returned through the original payment method. If Gerry cancels, you may choose a replacement or a full refund. Online service contracts ordinarily carry a 14-day cancellation period. For a call within that period, you expressly request early performance and acknowledge that the statutory cancellation right ends once the service has been fully performed. The pre-call refund policy and your statutory remedies remain available.</p><p>Before purchase, you separately agree to share the exact completed report with Gerry for preparation and the walkthrough, as described in the <a href="../privacy/#optional-call">privacy notice</a>. Discussion topics are optional. No adviser introduction is included. Earlier bookings, including manual Revolut Pro requests, retain the price and terms accepted for that request.</p></section>
<section class="page-card"><h2>Availability and your rights</h2><p>The app may be unavailable or produce an error. An incomplete analysis is identified; it is not a completed result. Nothing in these terms limits your mandatory rights under Irish or EU law.</p></section>
<section class="page-card"><h2>Changes and contact</h2><p>We explain material changes to the service or these terms before asking you to accept them. Irish law applies, subject to your mandatory consumer rights. Contact <a href="mailto:hello@planeir.ie">hello@planeir.ie</a> about questions or complaints.</p></section>
</div></main>${footer('../')}`;

const demoForm = (await readFile(resolve(root, 'apply/index.html'), 'utf8')).replaceAll('https://planeir.ie/apply/', 'https://planeir.ie/demo/').replace('<meta name="robots" content="index, follow" />', '<meta name="robots" content="noindex, nofollow" />').replace('<title>Request demo access | Planeir</title>', '<title>Your private demo | Planeir</title>');
const outputs = new Map([['demo/index.html', demoForm], ['index.html', home], ['privacy/index.html', privacy('../')], ['plan/privacy.html', privacy('../')], ['terms/index.html', terms]]);
let stale = false;
for (const [file, content] of outputs) {
  const output = resolve(root, file);
  const previous = await readFile(output, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  if (previous === content) continue;
  if (check) { console.error(`Workspace page is stale: ${file}`); stale = true; }
  else { await mkdir(dirname(output), { recursive: true }); await writeFile(output, content); console.log(`Wrote ${file}`); }
}
if (stale) process.exitCode = 1;
