import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_COPY as copy, WORKSPACE_FAQS, WORKSPACE_POLICY } from '../js/workspace/copy.js';

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
  <meta property="og:site_name" content="Planéir" />
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
  <link rel="stylesheet" href="${up}styles/workspace.css" />
${extra ? `  ${extra}\n` : ""}</head>
<body><div class="landing-shell">
  <div class="landing-ambient landing-ambient-one" aria-hidden="true"></div>
  <div class="landing-grid" aria-hidden="true"></div>`;
}
function header(up, admin = false) {
  return `<header class="site-header">
    <a class="site-brand" href="${up}" aria-label="Planéir home"><span class="site-brand-logo-wrap"><img class="site-brand-logo" src="${up}assets/brand/planeir-lockup-light.svg" alt="Planéir" width="1330" height="384" /></span></a>
    <nav class="site-header-actions" aria-label="Site">${admin ? `<a class="site-nav-admin-login" href="${up}app/?login=1&return=home" data-advisor-login-link>Admin login</a><a class="site-nav-app advisor-app-link is-hidden" href="${up}app/" data-advisor-app-link hidden>Open app</a>` : ''}<a class="button button-primary button-sm" href="${up}apply/">${copy.create}</a></nav>
  </header>`;
}
function footer(up) {
  return `<footer class="site-footer"><p class="site-footer-note">Planéir provides financial education, not regulated advice. <a href="${up}privacy/">Privacy</a> · <a href="${up}terms/">Terms</a> · <a href="mailto:hello@planeir.ie">hello@planeir.ie</a></p></footer></div></body></html>`;
}
const faq = WORKSPACE_FAQS.map(([question, answer]) => `<details class="faq-item"><summary>${escape(question)}</summary><p>${escape(answer)}</p></details>`).join('\n');
const structured = { '@context': 'https://schema.org', '@graph': [
  { '@type': 'WebSite', name: 'Planéir', alternateName: 'Planeir', url: 'https://planeir.ie/', inLanguage: 'en-IE', description: copy.description },
  { '@type': 'Person', name: 'Gerry Boylan', hasCredential: { '@type': 'EducationalOccupationalCredential', credentialCategory: 'Qualified Financial Adviser (QFA)', recognizedBy: { '@type': 'Organization', name: 'IOB' } } },
  { '@type': 'FAQPage', mainEntity: WORKSPACE_FAQS.map(([name, text]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text } })) }
] };
const home = `${head('Planéir | Private financial education', copy.description, './', '/', `<script type="application/ld+json">${scriptJson(structured)}</script>`)}
${header('./', true)}
<main>
  <section class="hero-section">
    <div class="hero-copy">
      <p class="section-eyebrow">Financial education for everyone · Built for Ireland</p>
      <h1 class="hero-title">${copy.headline}</h1>
      <p class="hero-subtitle">${copy.introduction}</p>
      <div class="hero-actions"><a class="button button-primary" href="./apply/">${copy.create}</a><a class="button button-secondary" href="#how-it-works">How it works</a></div>
    </div>
    <figure class="workspace-example product-preview" data-product-preview>
      <div class="preview-tabs" role="tablist" aria-label="Example modules"><button id="previewMortgageTab" type="button" role="tab" aria-selected="true" aria-controls="previewPanel" data-preview-module="mortgage">Mortgage</button><button id="previewBalanceTab" type="button" role="tab" aria-selected="false" aria-controls="previewPanel" tabindex="-1" data-preview-module="balance-sheet">Personal balance sheet</button></div>
      <div id="previewPanel" class="preview-stage" role="tabpanel" aria-labelledby="previewMortgageTab"><video data-preview-video muted playsinline preload="none" poster="./assets/examples/mortgage-preview-desktop-poster.png" width="1440" height="1080" aria-label="Mortgage scenario comparison using fictional figures"><source type="video/mp4" /><source type="video/webm" /></video></div>
      <div class="preview-controls"><span>Actual modules · Fictional figures</span><div><button type="button" data-preview-play>Play preview</button><button type="button" data-preview-enlarge>Enlarge</button></div></div>
      <figcaption data-preview-caption aria-live="polite">Compare how extra repayments change the finish date and interest cost.</figcaption>
      <dialog class="preview-dialog" aria-labelledby="previewDialogTitle"><div class="preview-dialog-header"><h2 id="previewDialogTitle">Planéir example · Fictional figures</h2><button type="button" data-preview-close>Close</button></div><video controls muted playsinline preload="none" aria-label="Enlarged module example"><source type="video/mp4" /><source type="video/webm" /></video><div class="preview-dialog-footer"><a class="button button-primary" href="./apply/">${copy.create}</a></div></dialog>
    </figure>
  </section>
  <section class="trust-row-section" aria-label="About Planéir"><div class="trust-row"><span>Designed by Gerry Boylan, QFA</span><span class="trust-row-divider" aria-hidden="true"></span><span>Built for Ireland</span><span class="trust-row-divider" aria-hidden="true"></span><span>Financial education</span></div></section>
  <section id="how-it-works" class="content-section how-section" aria-labelledby="howTitle"><div class="section-heading"><p class="section-eyebrow">How Planéir works</p><h2 id="howTitle">From your figures to a clearer picture.</h2></div><div class="how-grid">
    <article class="how-card"><h3>1. Enter your figures</h3><p>Tell Planéir about your goals, income, home, savings and pensions. Estimates are fine. Skip anything you don’t know.</p></article>
    <article class="how-card"><h3>2. Get your analysis</h3><p>AI helps identify the scenarios relevant to your objectives and organise your modules. Planéir runs the calculations.</p></article>
    <article class="how-card"><h3>3. Explore the outcomes</h3><p>Compare modelled outcomes, read all the assumptions and return to your saved workspace. Results are generated automatically.</p></article>
  </div></section>
  <section class="content-section how-section" aria-labelledby="founderTitle"><div class="section-heading"><p class="section-eyebrow">Why I built Planéir</p><h2 id="founderTitle">Financial understanding should not be a privilege.</h2></div><p class="workspace-founder">${copy.founder}</p><p class="workspace-founder">${copy.founderContext}</p></section>

  <section class="content-section faq-section" aria-labelledby="faqTitle"><div class="section-heading"><p class="section-eyebrow">Questions</p><h2 id="faqTitle">What to expect.</h2></div><div class="faq-list">${faq}</div></section>
  <section id="request-call" class="content-section"><div id="advisorGateNotice" class="advisor-gate-notice is-hidden" tabindex="-1" hidden><h2>The admin workspace is private.</h2><p>For the consumer service, start with the form below. Existing clients should use their secure link.</p></div><div class="how-card"><h2>Start with your own figures.</h2><p>See where you stand. Compare the choices ahead.</p><a class="button button-primary" href="./apply/">${copy.create}</a></div></section>
</main>
<script>window.__WORKER_BASE_URL = "https://api.planeir.ie";</script><script type="module" src="./js/landing.js"></script><script type="module" src="./js/workspace/previews.js"></script>
${footer('./')}`;

// The body is shared by both public notice URLs. Archived notices apply only
// to the old case-video service and the separately invited consumer beta.
const privacyBody = `<p class="section-eyebrow">Privacy notice · ${WORKSPACE_POLICY.privacyNoticeId}</p><h1 class="page-title">How we handle your information</h1>
<p class="page-lede">Planéir is operated by Gerry Boylan in Ireland. Contact <a href="mailto:hello@planeir.ie">hello@planeir.ie</a>.</p>
<div class="workspace-notice"><h2>Local form preview</h2><p>This notice describes the workspace service. In the current preview, submissions are disabled. Your draft is saved in this browser; it is not sent to Planéir or an AI provider. Use <strong>Clear form</strong> to remove it.</p></div>
<div class="page-content">
<section class="page-card"><h2>What the workspace collects</h2><p>Your name and email for return access, your question, the household details and figures you choose to enter, generated illustrations, and records of the terms and notices you acknowledge. Estimates and unknown figures are identified.</p><p>Do not enter PPS numbers, passwords, PINs, full account or card numbers, an exact address, identity documents or unnecessary information about someone else.</p></section>
<section class="page-card"><h2>Why we use it</h2><p>We use your information to prepare and save the workspace you request, provide return access and handle corrections or deletion. The lawful basis for this service is performance of our agreement with you under the Terms of Use.</p><p>Limited security and operational records support our legitimate interests in preventing misuse, controlling service costs and maintaining reliability. Optional calls are a separate service you request. The workspace does not publish your answers, sell your financial information or send it to an adviser.</p></section>
<section class="page-card"><h2>Automatic processing and AI</h2><p>${copy.aiNotice} ${copy.automaticNotice}</p><p>Relevant figures, objectives and written context are sent to the AI provider to identify scenarios and organise the relevant modules. This does not constitute a lending approval, product recommendation or decision that changes your financial arrangements. ${copy.assumptionsNotice}</p></section>
<section class="page-card"><h2>Who processes the information</h2><ul><li>Cloudflare provides the application infrastructure and encrypted storage.</li><li>OpenAI processes information for AI assistance.</li><li>Resend provides service emails and return-access emails when connected.</li><li>GitHub hosts the website pages.</li><li>Zoom hosts the optional private education calls.</li></ul><p>Authorised support, including Gerry, may access information when needed to operate the service, investigate a problem or respond to your request. A private workspace does not mean that no service provider or authorised support can access it.</p><p>Providers may process information outside the European Economic Area. The exact providers, processing locations and applicable transfer safeguards must be confirmed before workspace submissions are enabled; no claim about model training or zero provider retention is made here.</p></section>
<section class="page-card"><h2>Saved access and deletion</h2><p>Your workspace remains until you delete it. Deleting it removes the stored household information, conversations and results associated with it. In the local form preview, use <strong>Clear form</strong> to remove the draft from this device.</p><p>Separately retained security, email-delivery or booking records must be identified with their own purpose and retention period before the relevant information is collected. A workspace deletion does not silently change the records of a separate service you requested.</p></section>
<section class="page-card" id="optional-call"><h2>Optional private call</h2><p>After viewing your analysis, you can request a call with Gerry. The call details appear beside your results. Requesting a call shares your contact details and the discussion note you enter with Gerry. Your profile and calculation results are not copied automatically; you can share the analysis on screen during the call. Gerry proposes a time and emails a Zoom invitation to accept or decline. Calls are private and unrecorded by default. No adviser introduction is included.</p></section>
<section class="page-card"><h2>Your rights</h2><p>You may request access, correction, deletion, restriction or portability, or object to processing based on legitimate interests, where applicable. Where processing relies on consent, you may withdraw it without affecting earlier lawful processing. Email <a href="mailto:hello@planeir.ie">hello@planeir.ie</a>. You may complain to the <a href="https://www.dataprotection.ie/">Irish Data Protection Commission</a>.</p></section>
<section class="page-card" id="previous-services"><h2>Existing applications and invited sessions</h2><p>Earlier case-video applications remain covered by the <a href="/privacy/legacy-applications.html">original application notice</a>. The separately invited consumer beta remains covered by its <a href="/plan/privacy-legacy.html">original consumer notice</a>, including its seven-day session expiry and optional voice processing. Those permissions are not permission to create a new workspace.</p></section>
</div>`;
function privacy(up) {
  return `${head('Privacy notice | Planéir', 'How Planéir handles information in your private workspace, local form previews and earlier services.', up, '/privacy/')}${header(up)}<main class="page-main"><section class="page-intro">${privacyBody}</section></main>${footer(up)}`;
}
const terms = `${head('Terms of Use | Planéir', 'Terms for your private financial education workspace.', '../', '/terms/')}${header('../')}<main class="page-main"><section class="page-intro"><p class="section-eyebrow">Terms of Use · ${WORKSPACE_POLICY.termsId}</p><h1 class="page-title">Using Planéir</h1><p class="page-lede">These terms cover your private financial education workspace. The form currently runs as a local preview and saves a draft on this device only.</p></section><div class="page-content">
<section class="page-card"><h2>Who provides the service</h2><p>Planéir is built and run by Gerry Boylan, a sole trader based in Dublin, Ireland. Contact <a href="mailto:hello@planeir.ie">hello@planeir.ie</a>. These terms describe the private workspace; they do not replace the terms of an earlier invited session.</p></section>
<section class="page-card"><h2>Financial education</h2><p>${copy.educationNotice}</p><p>The service is for adults aged 18 or over using their own household information. Share another person’s information only where you are entitled to do so and it is needed.</p></section>
<section class="page-card"><h2>Information and assumptions</h2><p>${copy.aiNotice} ${copy.assumptionsNotice}</p><p>${copy.automaticNotice} Modelled outcomes are not guarantees. Correct inaccurate information and obtain appropriate professional advice before making a financial decision.</p></section>
<section class="page-card"><h2>Your saved workspace</h2><p>The workspace is free. It remains until you delete it. The <a href="../privacy/">privacy notice</a> explains processing, access and deletion.</p></section>
<section class="page-card"><h2>Optional education call</h2><p>After viewing your analysis, you can request a call with Gerry to talk through your figures, assumptions and modelled outcomes. The call details and booking terms appear there before you request it. Calls are private and unrecorded by default.</p></section>
<section class="page-card"><h2>Availability and your rights</h2><p>The app may be unavailable or produce an error. An incomplete analysis is identified; it is not a completed result. Nothing in these terms limits your mandatory rights under Irish or EU law.</p></section>
<section class="page-card"><h2>Changes and contact</h2><p>We explain material changes to the service or these terms before asking you to accept them. Irish law applies, subject to your mandatory consumer rights. Contact <a href="mailto:hello@planeir.ie">hello@planeir.ie</a> about questions or complaints.</p></section>
</div></main>${footer('../')}`;

const outputs = new Map([['index.html', home], ['privacy/index.html', privacy('../')], ['plan/privacy.html', privacy('../')], ['terms/index.html', terms]]);
let stale = false;
for (const [file, content] of outputs) {
  const output = resolve(root, file);
  const previous = await readFile(output, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  if (previous === content) continue;
  if (check) { console.error(`Workspace page is stale: ${file}`); stale = true; }
  else { await mkdir(dirname(output), { recursive: true }); await writeFile(output, content); console.log(`Wrote ${file}`); }
}
if (stale) process.exitCode = 1;
