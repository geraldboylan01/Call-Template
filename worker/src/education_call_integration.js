import { EDUCATION_CALL } from '../../js/workspace/education_call.js';
import { encryptPublishedSessionV4, decryptPublishedSessionWithRememberedDek } from '../../js/crypto_session.js';
import { requireConsumerSession } from './consumer/session_auth.js';
import { getCurrentProfile, getLatestAnalysis, getHandoff, readHandoffPackage } from './consumer/repository.js';
import { ConsumerError } from './consumer/errors.js';
import { sha256Base64Url, encryptJson, decryptJson } from './consumer/crypto.js';
import { educationCryptoEnv, getSavedEducationProfile } from './education_customer_profile.js';

const DAY = 86_400_000;
const fail = (status, code, message) => { throw new ConsumerError(status, code, message); };
const formatTime = value => new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin', dateStyle: 'full', timeStyle: 'short'
}).format(new Date(value));

// Existing storage, Zoom and mail helpers are injected by the Worker. No secrets
// from the request are included in events, mail or exception messages.
export function createEducationCallHooks(env, helpers) {
  async function analysisLinks(record, advisor = false) {
    if (!record.reportSnapshotId) return {};
    const report = await helpers.getPublishedSession(record.reportSnapshotId);
    if (!report || report.status !== 'active' || Date.parse(report.expiresAt) <= Date.now()) return {};
    const recovery = await helpers.recoverPublishedLinks(report);
    if (!recovery) return {};
    const base = `https://planeir.ie/app/education-call-report.html?pub=${encodeURIComponent(record.reportSnapshotId)}`;
    return {
      reportClientLink: `${base}#ck=${encodeURIComponent(recovery.clientSecretB64u)}`,
      ...(advisor ? {
        reportAdvisorLink: `${base}#ak=${encodeURIComponent(recovery.advisorSecretB64u)}`,
        reportClientPreviewLink: `${base}&view=client#ak=${encodeURIComponent(recovery.advisorSecretB64u)}`
      } : {})
    };
  }
  function mailConfig() {
    if (String(env.WALKTHROUGH_EMAILS_ENABLED) !== 'true') fail(503, 'walkthrough_email_disabled', 'Walkthrough email delivery is awaiting activation.');
    const config = helpers.emailConfig();
    if (!config.apiKey || !config.from) fail(503, 'email_unconfigured', 'Booking email is not configured.');
    return config;
  }
  return {
    requireAdvisor: helpers.requireAdvisor,
    canSendWalkthroughEmail: () => String(env.WALKTHROUGH_EMAILS_ENABLED) === 'true',
    encryptDiscussionTopics: (text, orderId) => encryptJson(educationCryptoEnv(env), { text }, `education/topics/${orderId}`),
    async decryptDiscussionTopics(encrypted, orderId) {
      return encrypted ? (await decryptJson(educationCryptoEnv(env), encrypted, `education/topics/${orderId}`)).text || '' : '';
    },
    async decoratePurchase(purchase, options = {}) {
      return { ...purchase, ...await analysisLinks(purchase, options.advisor === true) };
    },
    async decorateBooking(booking, options = {}) {
      const order = await env.LEADS_DB.prepare('SELECT id, discussion_topics_ciphertext FROM education_stripe_orders WHERE booking_id = ?').bind(booking.id).first();
      const discussionTopics = order?.discussion_topics_ciphertext
        ? (await decryptJson(educationCryptoEnv(env), order.discussion_topics_ciphertext, `education/topics/${order.id}`)).text || '' : '';
      return { ...booking, ...(order ? { purchaseId: order.id, discussionTopics } : {}), ...await analysisLinks(booking, options.advisor === true) };
    },
    async sendPurchaseEmail(job) {
      const config = mailConfig();
      const { purchase } = job;
      const admin = job.kind === 'purchase_paid_admin';
      const fullName = purchase.contact?.fullName || purchase.fullName;
      const email = purchase.contact?.email || purchase.email;
      const firstName = fullName.split(/\s+/)[0];
      const scheduleUrl = `https://planeir.ie/app/walkthrough-payment.html#purchase=${encodeURIComponent(purchase.id)}&token=${encodeURIComponent(purchase.accessToken)}`;
      const links = await analysisLinks(purchase, admin);
      const cancelled = purchase.status === 'cancelled' || purchase.booking?.status === 'cancelled';
      const booked = !cancelled ? purchase.booking : null;
      const amount = new Intl.NumberFormat('en-IE', { style: 'currency', currency: purchase.currency || 'EUR' }).format(purchase.amountCents / 100);
      let subject, lines;
      if (admin) {
        if (!config.advisorCopyRecipients?.length) fail(503, 'admin_email_missing', 'Walkthrough administrator email is not configured.');
        subject = `Planéir — New walkthrough purchase: ${fullName}`;
        lines = ['Hi Gerry,', '', 'A customer has purchased a personalised Planéir walkthrough.', '',
          `Name: ${fullName}`, `Email: ${email}`, `Amount: ${amount}`, 'Status: Paid — Stripe verified',
          `Payment date: ${formatTime(purchase.paidAt || purchase.paymentVerifiedAt || purchase.createdAt)}`,
          `Reference: ${purchase.id}`, '',
          `View advisor analysis: ${links.reportAdvisorLink || 'Report access is being prepared. Open the client pipeline.'}`,
          `View client analysis: ${links.reportClientPreviewLink || 'Report access is being prepared. Open the client pipeline.'}`, '',
          `Appointment status: ${cancelled ? 'Cancelled — review the original payment for refund' : booked ? 'Scheduled' : 'Awaiting scheduling'}`];
        if (booked) lines.push(`When: ${formatTime(booked.startAt)} — Europe/Dublin`, `Zoom: ${booked.zoomJoinUrl || 'Meeting details are being prepared.'}`);
        lines.push('', 'Manage walkthroughs: https://planeir.ie/app/clients.html');
      } else {
        subject = 'Your Planéir walkthrough — payment confirmed';
        lines = [`Hi ${firstName},`, '', 'Thank you for choosing Planéir!', '',
          `Your payment of ${amount} for a personalised walkthrough has been received.`,
          "As the person who designed and built Planéir, I'm looking forward to walking you through your financial analysis, explaining the tools and exploring your questions.", ''];
        if (cancelled) {
          lines.push('Your walkthrough has since been cancelled. Gerry will review the payment for a refund through the original payment method.',
            `Review your walkthrough: ${scheduleUrl}`);
        } else if (booked) {
          lines.push(`Your time is booked: ${formatTime(booked.startAt)} — Europe/Dublin.`,
            booked.zoomJoinUrl ? `Join Zoom: ${booked.zoomJoinUrl}` : 'Your Zoom meeting details will follow in a separate confirmation.',
            `Review your walkthrough: ${scheduleUrl}`);
        } else lines.push("The next step is to choose a time for our Zoom call.", `Schedule your walkthrough: ${scheduleUrl}`,
          'Walkthroughs must be booked at least 24 hours in advance, giving me time to review your analysis and prepare.',
          "When booking, you can share anything you'd particularly like to discuss. Once you've selected a time, we'll email your Zoom meeting details.");
        lines.push('', 'Your payment record is saved. This private link returns to the same purchase; it does not create another charge.',
          '', 'Best regards,', 'Gerry', 'Founder, Planéir', 'https://planeir.ie');
      }
      return helpers.sendEmail(config, { from: config.from, to: admin ? config.advisorCopyRecipients : [email],
        reply_to: config.replyTo || undefined, subject, text: lines.join('\n') }, job.idempotencyKey);
    },
    async resolveCustomer(request, body, options = {}) {
      if (body.sourceType === 'consumer') {
        const sessionRow = await requireConsumerSession(request, env, body.sourceId);
        if (!sessionRow.confirmed_profile_revision
          || Number(sessionRow.confirmed_profile_revision) !== Number(sessionRow.current_profile_revision)) {
          fail(409, 'profile_confirmation_required', 'Review and confirm your current information first.');
        }
        const profile = await getCurrentProfile(env, sessionRow);
        const analysis = await getLatestAnalysis(env, sessionRow.id, sessionRow.confirmed_profile_revision, { completedOnly: true });
        if (!analysis || analysis.calculationPerformed === false || !analysis.results?.length) {
          fail(409, 'current_analysis_required', 'Complete your analysis before booking a walkthrough.');
        }
        if (!body.analysisRunId || body.analysisRunId !== analysis.id) {
          fail(409, 'analysis_changed', 'Your results have changed. Review the current report before booking.');
        }
        let contact = await getSavedEducationProfile(env, 'consumer', sessionRow.id);
        if (!contact) {
          const handoff = await getHandoff(env, sessionRow.id);
          if (handoff?.package_encrypted && !handoff.package_purged_at
            && !['revoked', 'purged'].includes(handoff.status) && Date.parse(handoff.retention_expires_at) > Date.now()) {
            contact = (await readHandoffPackage(env, handoff)).contact;
          }
        }
        if (!contact) {
          const previous = await env.LEADS_DB.prepare(`SELECT full_name, email, phone FROM education_bookings
            WHERE source_type = 'consumer' AND source_id = ? ORDER BY created_at DESC LIMIT 1`).bind(sessionRow.id).first();
          if (previous) contact = { fullName: previous.full_name, email: previous.email, phone: previous.phone || '' };
        }
        return { sourceType: 'consumer', sourceId: sessionRow.id, customerId: sessionRow.id, sessionRow, profile, analysis, contact };
      }
      if (body.sourceType !== 'published' || typeof body.sourceId !== 'string') {
        fail(400, 'invalid_source', 'Choose a completed report.');
      }
      const sourceRow = await helpers.getPublishedSession(body.sourceId);
      if (!sourceRow || !await helpers.verifyPublishedCapability(request, sourceRow, 'client')) {
        fail(404, 'not_found', 'This report is not available.');
      }
      if (sourceRow.status !== 'active' || Date.parse(sourceRow.expiresAt) <= Date.now()) {
        fail(410, 'report_expired', 'This report is no longer available.');
      }
      const contact = await getSavedEducationProfile(env, 'published', sourceRow.id)
        || (sourceRow.clientName && sourceRow.clientEmail
          ? { fullName: sourceRow.clientName, email: sourceRow.clientEmail, phone: '' } : null);
      if (options.profileOnly) return { sourceType: 'published', sourceId: sourceRow.id, sourceRow, contact };
      if (typeof body.reportDekB64u !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.reportDekB64u)) {
        fail(400, 'report_unlock_required', 'Unlock this report again before sharing it with Gerry.');
      }
      let reportJson;
      try {
        const bundle = await helpers.loadPublishedBundle(sourceRow.clientR2Key);
        reportJson = await decryptPublishedSessionWithRememberedDek(bundle, body.reportDekB64u);
      } catch {
        fail(400, 'report_unlock_required', 'Unlock this report again before sharing it with Gerry.');
      }
      return { sourceType: 'published', sourceId: sourceRow.id, customerId: sourceRow.clientId || sourceRow.id, sourceRow, reportJson, contact };
    },
    async createLead(context, body) {
      const contact = body.contact;
      const receipt = await helpers.createPipelineLead({
        handoffId: body.bookingId,
        callOfferVersion: EDUCATION_CALL.version,
        fullName: contact.fullName, email: contact.email, phone: contact.phone || '',
        requestedHelp: contact.requestedHelp || 'Walk through my completed Planeir report.',
        consentPolicyVersion: EDUCATION_CALL.version,
        policyUrl: 'https://planeir.ie/terms/#walkthrough',
        consentCapturedAt: new Date().toISOString(),
        sharedDataDigestB64u: await sha256Base64Url(JSON.stringify({
          bookingId: body.bookingId, sourceType: context.sourceType, sourceId: context.sourceId,
          reportAccess: true, offerVersion: EDUCATION_CALL.version
        })),
        retentionPolicyId: 'education-walkthrough-v2'
      });
      context.clientId = receipt.clientId;
      return { id: receipt.leadId, ...receipt };
    },
    async createReportSnapshot(context, body) {
      const db = env.LEADS_DB;
      const timestamp = new Date().toISOString();
      const expiresAt = new Date(body.startAt ? Date.parse(body.startAt) + 40 * 60_000 + 30 * DAY : Date.now() + 90 * DAY).toISOString();
      const newId = crypto.randomUUID();
      const claimed = await db.prepare(`INSERT OR IGNORE INTO education_call_reports
        (booking_id,published_id,source_type,source_id,analysis_run_id,profile_revision,
         consent_version,consent_captured_at,state,lease_expires_at,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?, 'building',?,?,?)`).bind(
        body.bookingId, newId, context.sourceType, context.sourceId,
        context.analysis?.id || null, context.analysis?.profileRevision || null,
        EDUCATION_CALL.version, timestamp, new Date(Date.now() + 120_000).toISOString(), timestamp, expiresAt
      ).run();
      const saved = await db.prepare('SELECT * FROM education_call_reports WHERE booking_id = ?').bind(body.bookingId).first();
      if (context.sourceType === 'consumer' && saved.analysis_run_id !== context.analysis.id) {
        fail(409, 'analysis_changed', 'Review the current report before making a new booking request.');
      }
      if (saved.state === 'ready') return { id: saved.published_id };
      if (!claimed.meta?.changes) {
        const retry = await db.prepare(`UPDATE education_call_reports SET lease_expires_at = ?
          WHERE booking_id = ? AND state = 'building' AND lease_expires_at <= ?`).bind(
          new Date(Date.now() + 120_000).toISOString(), body.bookingId, timestamp
        ).run();
        if (!retry.meta?.changes) fail(409, 'report_preparing', 'Your report is being prepared. Please retry shortly.');
      }
      try {
        // A completed previous storage operation can be recovered without ever
        // rewriting its ciphertext or rotating the original report's keys.
        let reportJson = context.reportJson;
        if (context.sourceType === 'consumer') {
          // Preserve every completed module and its original client-facing
          // outputs. The legacy workspace publisher supports only two module
          // builders and would silently omit the rest of this report.
          reportJson = JSON.stringify({
            kind: 'consumer-analysis-snapshot', clientName: body.contact.fullName,
            session: { id: context.sourceId,
              confirmedProfileRevision: Number(context.sessionRow.confirmed_profile_revision),
              currentProfileRevision: Number(context.sessionRow.current_profile_revision) },
            profile: { revision: Number(context.sessionRow.current_profile_revision),
              missingInformation: context.profile.missingInformation || [] },
            analysis: context.analysis
          });
        }
        const digest = await sha256Base64Url(reportJson);
        if (saved.report_digest && saved.report_digest !== digest) fail(409, 'report_changed', 'The report no longer matches this booking permission.');
        // Persist the immutable digest before external storage, including for
        // recovery after a Worker stops between object and row writes.
        await db.prepare('UPDATE education_call_reports SET report_digest = ? WHERE booking_id = ?').bind(digest, body.bookingId).run();
        if (!await helpers.getPublishedSession(saved.published_id)) {
          if (context.sourceType === 'published') await helpers.copyReportAssets(context.sourceId, saved.published_id, reportJson);
          const encrypted = await encryptPublishedSessionV4({
            clientSessionJson: reportJson, advisorSessionJson: reportJson,
            clientName: body.contact.fullName, clientEmail: body.contact.email,
            expiresInDays: Math.max(30, Math.ceil((Date.parse(saved.expires_at) - Date.now()) / DAY))
          });
          await helpers.storePublishedSession({
            publishedId: saved.published_id, createdAt: saved.created_at, expiresAt: saved.expires_at,
            clientName: body.contact.fullName, clientEmail: body.contact.email,
            clientId: context.clientId, sourceLeadId: body.leadId,
            reportKind: context.sourceType === 'consumer' ? 'consumer-analysis-snapshot' : context.sourceRow.reportKind || 'workspace',
            requestBody: encrypted.requestBody,
            recovery: { clientSecretB64u: encrypted.clientSecretB64u, advisorSecretB64u: encrypted.advisorSecretB64u }
          });
        }
        await db.prepare("UPDATE education_call_reports SET state = 'ready', lease_expires_at = NULL WHERE booking_id = ?").bind(body.bookingId).run();
        return { id: saved.published_id };
      } catch (error) {
        await db.prepare("UPDATE education_call_reports SET lease_expires_at = ? WHERE booking_id = ? AND state = 'building'").bind(timestamp, body.bookingId).run();
        throw error;
      }
    },
    async createZoom(booking) {
      const lead = await helpers.getLead(booking.leadId);
      return helpers.createZoom(lead, {
        scheduledStartAt: booking.startAt, scheduledEndAt: booking.endAt, scheduledTimezone: 'Europe/Dublin'
      });
    },
    async updateZoom(booking) {
      return helpers.updateZoom(booking);
    },
    async cancelZoom(booking) {
      if (booking.zoomMeetingId) {
        const result = await helpers.deleteZoom(booking.zoomMeetingId);
        if (!result?.deleted) throw new Error('Zoom cancellation failed. Retry meeting delivery from the booking controls.');
      }
    },
    async sendEmail(job) {
      const { booking } = job;
      const lead = await helpers.getLead(booking.leadId);
      if (!lead) fail(503, 'booking_contact_missing', 'Booking contact is not available.');
      const config = helpers.emailConfig();
      if (!config.apiKey || !config.from) fail(503, 'email_unconfigured', 'Booking email is not configured.');
      if (booking.paymentProvider === 'stripe') mailConfig();
      const statusUrl = `https://planeir.ie/app/education-call.html#booking=${encodeURIComponent(booking.id)}&token=${encodeURIComponent(booking.accessToken)}`;
      const links = await analysisLinks(booking, job.kind === 'booking_confirmed_admin');
      if (job.kind === 'booking_confirmed_admin') {
        if (!config.advisorCopyRecipients?.length) fail(503, 'admin_email_missing', 'Walkthrough administrator email is not configured.');
        return helpers.sendEmail(config, { from: config.from, to: config.advisorCopyRecipients,
          reply_to: config.replyTo || undefined,
          subject: `Planéir walkthrough booked — ${lead.fullName} — ${formatTime(booking.startAt)}`,
          text: ['Hi Gerry,', '', 'A customer has booked their personalised Planéir walkthrough.', '',
            `Name: ${lead.fullName}`, `Email: ${lead.email}`, '',
            `Date and time: ${formatTime(booking.startAt)} — Europe/Dublin`,
            `Duration: ${booking.offer?.durationMinutes || EDUCATION_CALL.durationMinutes} minutes`, `Join Zoom: ${booking.zoomJoinUrl}`, '',
            "What the customer would like to discuss:", booking.discussionTopics || 'No specific discussion topics provided.', '',
            `View advisor analysis: ${links.reportAdvisorLink || 'Open the consented report from the client pipeline.'}`,
            `View client analysis: ${links.reportClientPreviewLink || 'Open the consented report from the client pipeline.'}`, '',
            'Payment status: Confirmed',
            `Amount: ${new Intl.NumberFormat('en-IE', { style: 'currency', currency: booking.currency }).format(booking.amountCents / 100)}`,
            `Booking reference: ${booking.purchaseId || booking.id}`, `Payment reference: ${booking.paymentReference}`, '',
            'Manage walkthroughs: https://planeir.ie/app/clients.html'].join('\n')
        }, job.idempotencyKey);
      }
      const lines = [
        `Hello ${lead.fullName},`, '',
        `Your Planeir report walkthrough: ${formatTime(booking.startAt)} (Dublin time).`,
        `${EDUCATION_CALL.durationMinutes} minutes on Zoom. ${EDUCATION_CALL.priceLabel} total.`, ''
      ];
      let subject = 'Your provisional Planeir walkthrough';
      const attachments = [];
      if (job.kind === 'booking_confirmed') {
        subject = booking.paymentProvider === 'stripe' ? `Your Planéir walkthrough is booked — ${formatTime(booking.startAt)}` : 'Your Planeir walkthrough is confirmed';
        lines.push('Your payment is verified and your time is confirmed.', `Join Zoom: ${booking.zoomJoinUrl}`);
        lines.push("I'm looking forward to meeting you and exploring your financial analysis together.",
          "Before our call, I'll review your analysis and any questions you've shared so we can make the most of our time together.");
        if (links.reportClientLink) lines.push(`View your Planéir analysis: ${links.reportClientLink}`);
        if (booking.discussionTopics) lines.push('', 'Your discussion topics:', booking.discussionTopics);
        const schedule = {
          scheduledStartAt: booking.startAt, scheduledEndAt: booking.endAt, scheduledTimezone: 'Europe/Dublin',
          scheduledMessage: 'Your private educational report walkthrough is confirmed.',
          scheduledLocation: booking.zoomJoinUrl, zoomJoinUrl: booking.zoomJoinUrl,
          zoomMeetingId: booking.zoomMeetingId, scheduleInviteUid: `planeir-walkthrough-${booking.id}@planeir.ie`
        };
        attachments.push({ filename: 'planeir-walkthrough.ics', content: helpers.encodeBase64(helpers.buildIcs(lead, schedule, config)) });
      } else if (job.kind === 'payment_instructions') {
        subject = 'Payment link for your Planeir walkthrough';
        lines.push(`Pay securely with Revolut Pro: ${booking.paymentLink}`, 'Gerry will verify payment before the final Zoom invitation is sent.');
      } else if (job.kind === 'replacement_proposed') {
        subject = 'A proposed new time for your Planeir walkthrough';
        lines.push(`Proposed time: ${formatTime(booking.proposal.startAt)} (Dublin time).`,
          'Your original booking remains in place until you accept the change.', `Review and accept or decline: ${statusUrl}`);
      } else if (job.kind === 'booking_cancelled') {
        subject = 'Your Planeir walkthrough has been cancelled';
        lines.push('Your booking has been cancelled. If you paid, Gerry will arrange your refund through the original payment provider.');
      } else if (job.kind === 'booking_expired') {
        subject = 'Your provisional Planeir booking has expired';
        lines.push('Payment was not verified before the deadline, so the time has been released. If you paid, contact Gerry for rebooking or refund review.');
      } else if (job.kind === 'replacement_declined') {
        subject = 'Your original Planeir walkthrough time is retained';
        lines.push('The proposed change was declined. Your original time remains reserved.');
      } else if (job.kind === 'booking_updated') {
        subject = 'Your Planeir walkthrough time has been updated';
        lines.push('Your new time is reserved. Your existing payment instructions and verification status still apply.');
      } else {
        lines.push(String(env.STRIPE_WALKTHROUGHS_ENABLED) === 'true' && !booking.paymentLink
          ? 'This time is reserved provisionally. Open your private booking page below to pay securely with Stripe.'
          : 'This time is reserved provisionally. Gerry will email your Revolut Pro payment link.');
      }
      if (booking.holdExpiresAt && booking.paymentStatus !== 'verified') lines.push(`Reservation deadline: ${formatTime(booking.holdExpiresAt)} (Dublin time).`);
      lines.push('', `Manage your booking: ${statusUrl}`, '',
        'Your analysis remains free. This call explains your report, assumptions and scenarios; it does not include product recommendations or an adviser introduction.',
        'Cancel before the call for a full refund: hello@planeir.ie. Your statutory rights remain.',
        'Booking terms: https://planeir.ie/terms/#walkthrough', 'Privacy: https://planeir.ie/privacy/#optional-call',
        'Gerry Boylan, Dublin, Ireland. hello@planeir.ie');
      const result = await helpers.sendEmail(config, {
        from: config.from, to: [lead.email], reply_to: config.replyTo || undefined,
        subject, text: lines.join('\n'), ...(attachments.length ? { attachments } : {})
      }, job.idempotencyKey);
      if (job.kind === 'booking_received') {
        if (config.advisorCopyRecipients?.length) await helpers.sendEmail(config, {
          from: config.from, to: config.advisorCopyRecipients,
          subject: 'New paid walkthrough request',
          text: `${lead.fullName} selected ${formatTime(booking.startAt)}. Add their Revolut Pro payment link in the client pipeline.\nhttps://planeir.ie/app/clients.html`
        }, `${job.idempotencyKey}-advisor`);
      }
      return result;
    }
  };
}
